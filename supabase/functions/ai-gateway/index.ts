// =============================================================================
// MATRIX AI — AI Gateway (Supabase Edge Function)
//
// The ONLY way the frontend talks to Groq. Pipeline (spec §24):
//   Auth → Rate limit → PII detection/redaction → Cyber domain classification
//   → Cyber safety classification → Prompt construction → RAG retrieval
//   → Groq → Output safety validation → Store allowed response → Return
//
// Actions:
//   POST { action: "chat", conversation_id?, is_temporary, message }
//   POST { action: "scan", storage_path }   (screenshot analysis)
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, handleCors } from "../_shared/cors.ts";
import { redactPII, containsCredentials, leakedPII } from "../_shared/pii.ts";
import { classify } from "../_shared/domain.ts";
import { createProvider, MODELS, type AIMessage } from "../_shared/groq.ts";
import { buildSystemMessages, validateOutput, buildSummaryPrompt } from "../_shared/prompts.ts";
import { validateImageUpload } from "../_shared/storage.ts";

const RATE_LIMITS: Record<string, { perMinute: number; perDay: number }> = {
  chat: { perMinute: 20, perDay: 300 },
  scan: { perMinute: 5, perDay: 50 },
  summary: { perMinute: 10, perDay: 100 },
};

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function getUser(req: Request): Promise<{ user: { id: string; email?: string } | null; error: string | null }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { user: null, error: "MISSING_TOKEN" };
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return { user: null, error: "INVALID_TOKEN" };
  return { user: { id: data.user.id, email: data.user.email }, error: null };
}

async function checkRateLimit(sb: ReturnType<typeof adminClient>, userId: string, kind: keyof typeof RATE_LIMITS): Promise<{ ok: boolean; message?: string }> {
  const { perMinute, perDay } = RATE_LIMITS[kind];
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

  const { count: minuteCount, error: e1 } = await sb
    .from("ai_usage_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("request_type", kind)
    .gte("created_at", minuteAgo);
  if (e1) return { ok: false, message: "RATE_CHECK_FAILED" };
  if ((minuteCount ?? 0) >= perMinute) return { ok: false, message: "RATE_LIMITED_MINUTE" };

  const { count: dayCount, error: e2 } = await sb
    .from("ai_usage_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("request_type", kind)
    .gte("created_at", dayAgo);
  if (e2) return { ok: false, message: "RATE_CHECK_FAILED" };
  if ((dayCount ?? 0) >= perDay) return { ok: false, message: "RATE_LIMITED_DAY" };

  return { ok: true };
}

async function logUsage(
  sb: ReturnType<typeof adminClient>,
  userId: string,
  model: string,
  requestType: string,
  tokenUsage: unknown,
  latencyMs: number,
  status: string,
) {
  await sb.from("ai_usage_logs").insert({
    user_id: userId,
    model,
    request_type: requestType,
    token_usage: tokenUsage,
    latency_ms: latencyMs,
    status,
  });
}

async function logSafety(sb: ReturnType<typeof adminClient>, userId: string | null, eventType: string, detail: string) {
  await sb.from("ai_safety_events").insert({ user_id: userId, event_type: eventType, detail: detail.slice(0, 500) });
}

// ---------------------------------------------------------------------------
// RAG context + memory + reporting grounding
// ---------------------------------------------------------------------------
async function buildRagContext(sb: ReturnType<typeof adminClient>, message: string, country: string | null): Promise<string> {
  const parts: string[] = [];
  const { data: chunks } = await sb.rpc("rag_search", { p_query: message.slice(0, 200), p_limit: 4 });
  if (chunks && Array.isArray(chunks)) {
    for (const c of chunks.slice(0, 3)) {
      parts.push(`[${c.source_type}] ${c.title}: ${String(c.content).slice(0, 600)}`);
    }
  }
  if (country) {
    const { data: resources } = await sb
      .from("reporting_resources")
      .select("organization, official_url, phone, description, category")
      .eq("country_id", country)
      .eq("status", "active")
      .limit(3);
    if (resources && resources.length > 0) {
      parts.push("Verified reporting resources (use ONLY these):");
      for (const r of resources) {
        parts.push(`- ${r.organization} — ${r.official_url}${r.phone ? " / " + r.phone : ""}: ${r.description}`);
      }
    }
  }
  return parts.join("\n");
}

async function loadSafeMemories(sb: ReturnType<typeof adminClient>, userId: string): Promise<string> {
  const { data } = await sb.from("user_memories").select("memory").eq("user_id", userId).limit(5);
  if (!data || data.length === 0) return "";
  return data.map((m) => `- ${m.memory}`).join("\n");
}

// ---------------------------------------------------------------------------
// Chat action
// ---------------------------------------------------------------------------
async function handleChat(sb: ReturnType<typeof adminClient>, user: { id: string }, body: Record<string, unknown>) {
  const started = Date.now();
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
  const isTemporary = body.is_temporary === true;

  if (!message) return jsonResponse({ error: "MESSAGE_REQUIRED" }, 400);
  if (message.length > 4000) return jsonResponse({ error: "MESSAGE_TOO_LONG" }, 400);

  const rate = await checkRateLimit(sb, user.id, "chat");
  if (!rate.ok) {
    await logSafety(sb, user.id, "safety_refusal", "rate_limited");
    return jsonResponse({ error: rate.message }, 429);
  }

  // --- conversation resolution -------------------------------------------------
  let convId = conversationId;
  if (convId) {
    const { data: conv } = await sb
      .from("conversations")
      .select("id, is_temporary")
      .eq("id", convId)
      .eq("user_id", user.id)
      .single();
    if (!conv) return jsonResponse({ error: "CONVERSATION_NOT_FOUND" }, 404);
  } else {
    const title = message.replace(/\s+/g, " ").slice(0, 60);
    const { data: created, error: convErr } = await sb
      .from("conversations")
      .insert({ user_id: user.id, title, is_temporary: isTemporary })
      .select("id")
      .single();
    if (convErr || !created) return jsonResponse({ error: "CONVERSATION_CREATE_FAILED" }, 500);
    convId = created.id;
  }

  // --- store the user message (original stays in the DB; PII never hits Groq) --
  const redaction = redactPII(message);
  const userMsgRow = { conversation_id: convId, role: "user", content: message, metadata: { pii_redacted: !redaction.safe, detected: redaction.detected.map((d) => d.type) } };
  await sb.from("conversation_messages").insert(userMsgRow);

  // --- classification (no LLM call needed for refusals) ------------------------
  const classification = classify(redaction.redacted);
  if (!classification.on_topic) {
    await logSafety(sb, user.id, "off_topic", "off-topic request refused");
    await logUsage(sb, user.id, "none", "chat", {}, Date.now() - started, "refused");
    await sb.from("conversation_messages").insert({ conversation_id: convId, role: "assistant", content: classification.refusal! });
    return jsonResponse({ reply: classification.refusal, conversation_id: convId, refused: true, reason: "off_topic" });
  }
  if (classification.harmful) {
    await logSafety(sb, user.id, "harmful_request", classification.harmful_category ?? "harmful");
    await logUsage(sb, user.id, "none", "chat", {}, Date.now() - started, "refused");
    await sb.from("conversation_messages").insert({ conversation_id: convId, role: "assistant", content: classification.refusal! });
    return jsonResponse({ reply: classification.refusal, conversation_id: convId, refused: true, reason: "harmful" });
  }
  if (redaction.detected.some((d) => d.type === "otp" || d.type === "password")) {
    await logSafety(sb, user.id, "pii_detected", redaction.detected.map((d) => d.type).join(","));
  }

  // --- prompt construction -----------------------------------------------------
  const provider = createProvider();
  if (!provider) {
    await sb.from("conversation_messages").insert({
      conversation_id: convId, role: "assistant",
      content: "The AI gateway is not configured yet. Please set the GROQ_API_KEY secret on this project to enable chat.",
    });
    await logUsage(sb, user.id, "none", "chat", {}, Date.now() - started, "error");
    return jsonResponse({ reply: "AI_GATEWAY_NOT_CONFIGURED", conversation_id: convId }, 503);
  }

  // Context: summary + recent messages (already redacted on the way in) + memory + RAG
  const { data: summaryRow } = await sb.from("conversation_summaries").select("summary").eq("conversation_id", convId).maybeSingle();
  const { data: recent } = await sb
    .from("conversation_messages")
    .select("role, content, created_at")
    .eq("conversation_id", convId)
    .not("role", "eq", "system")
    .order("created_at", { ascending: false })
    .limit(8);
  const history: AIMessage[] = [];
  if (summaryRow?.summary) history.push({ role: "system", content: "Summary of the earlier conversation:\n" + summaryRow.summary });
  if (recent) {
    for (const m of [...recent].reverse()) {
      if (m.role === "user" || m.role === "assistant") history.push({ role: m.role, content: m.content });
    }
  }
  const memories = await loadSafeMemories(sb, user.id);
  if (memories) history.push({ role: "system", content: "Safe context about the user (never repeat back verbatim):\n" + memories });

  const { data: profile } = await sb.from("profiles").select("country, full_name").eq("id", user.id).single();
  const rag = await buildRagContext(sb, redaction.redacted, profile?.country ?? null);

  const messages: AIMessage[] = [
    ...buildSystemMessages(rag, false),
    ...history,
    { role: "user", content: redaction.redacted },
  ];

  // --- Groq ---------------------------------------------------------------------
  let reply: string;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  try {
    const result = await provider.chat({ model: MODELS.chat, messages, temperature: 0.4, maxTokens: 1024 });
    reply = result.content;
    usage = result.usage;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    await logUsage(sb, user.id, MODELS.chat, "chat", {}, Date.now() - started, "error");
    await sb.from("conversation_messages").insert({
      conversation_id: convId, role: "assistant",
      content: "I hit a technical hiccup. Please try again in a moment.",
    });
    return jsonResponse({ error: "AI_GATEWAY_ERROR", detail: msg }, 502);
  }

  // --- output validation ---------------------------------------------------------
  const check = validateOutput(reply);
  if (!check.ok) {
    await logSafety(sb, user.id, "output_blocked", check.reason ?? "unknown");
    reply = "I'm sorry — I can only provide defensive, safe guidance. Let me know what happened and I'll help you fix it.";
  }
  const leaks = leakedPII(message, reply);
  if (leaks.length > 0) {
    await logSafety(sb, user.id, "pii_detected", "response echoed PII");
    for (const l of leaks) reply = reply.replaceAll(l, "[redacted]");
  }

  await sb.from("conversation_messages").insert({ conversation_id: convId, role: "assistant", content: reply });

  // --- rolling summary for permanent chats (spec §21) ----------------------------
  if (!isTemporary) {
    const { count } = await sb
      .from("conversation_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", convId)
      .eq("role", "user");
    if ((count ?? 0) >= 10 && (count ?? 0) % 10 === 0) {
      try {
        const sum = await provider.chat({ model: MODELS.fast, messages: [{ role: "user", content: buildSummaryPrompt(history.slice(-6)) }], maxTokens: 300 });
        await sb.from("conversation_summaries").upsert({ conversation_id: convId, summary: sum.content, message_count: count ?? 0 }, { onConflict: "conversation_id" });
      } catch {
        // Summaries are best-effort; never fail the chat over them.
      }
    }
  }

  // --- memory extraction (spec §20) — only safe, useful context ------------------
  if (!isTemporary && redaction.safe && message.toLowerCase().includes("remember") === false) {
    const { count } = await sb
      .from("conversation_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", convId)
      .eq("role", "user");
    if ((count ?? 0) % 5 === 0 && (count ?? 0) > 0) {
      try {
        const mem = await provider.chat({
          model: MODELS.fast,
          messages: [
            { role: "system", content: "Extract at most one safe, useful fact about the user relevant to cybersecurity learning (e.g. 'User is a beginner in cybersecurity.', 'User uses an Android phone.'). Return ONLY the fact, or the word NONE if nothing is worth remembering. Never output passwords, codes, IDs, emails, addresses or payment info." },
            { role: "user", content: redaction.redacted },
          ],
          maxTokens: 60,
        });
        const fact = mem.content.trim();
        if (fact && fact !== "NONE" && fact.length < 160) {
          await sb.from("user_memories").insert({ user_id: user.id, memory: fact, source: "ai" });
        }
      } catch {
        // best-effort
      }
    }
  }

  await logUsage(sb, user.id, MODELS.chat, "chat", usage, Date.now() - started, "ok");
  return jsonResponse({ reply, conversation_id: convId, refused: false, pii_redacted: !redaction.safe });
}

// ---------------------------------------------------------------------------
// Scan action (screenshot analysis, spec §14)
// ---------------------------------------------------------------------------
async function handleScan(sb: ReturnType<typeof adminClient>, user: { id: string }, body: Record<string, unknown>) {
  const started = Date.now();
  const storagePath = typeof body.storage_path === "string" ? body.storage_path.trim() : "";
  if (!storagePath) return jsonResponse({ error: "STORAGE_PATH_REQUIRED" }, 400);

  // Ownership: files must live in the user's own folder.
  if (!storagePath.startsWith(`${user.id}/`)) {
    await logSafety(sb, user.id, "safety_refusal", "storage path ownership violation");
    return jsonResponse({ error: "STORAGE_OWNERSHIP_VIOLATION" }, 403);
  }

  const rate = await checkRateLimit(sb, user.id, "scan");
  if (!rate.ok) return jsonResponse({ error: rate.message }, 429);

  const { data: file } = await sb.storage.from("security-screenshots").download(storagePath);
  if (!file) return jsonResponse({ error: "FILE_NOT_FOUND" }, 404);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const check = validateImageUpload(bytes, null);
  if (!check.ok) {
    await logSafety(sb, user.id, "safety_refusal", "invalid upload: " + check.error);
    return jsonResponse({ error: check.error }, 400);
  }

  const provider = createProvider();
  if (!provider) return jsonResponse({ error: "AI_GATEWAY_NOT_CONFIGURED" }, 503);

  // Chunked base64 (never spread large byte arrays into function args).
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const dataUrl = `data:${check.mime};base64,${btoa(binary)}`;

  const prompt =
    `Analyse this screenshot for a teen cybersecurity education platform. The user uploaded it to ask whether it is suspicious. ` +
    `Answer with EXACTLY these sections:\nRisk (low/medium/high/critical)\nConfidence (0-100%)\nWhat I noticed\nWhy it matters\nWhat to do now\nWhat not to do\nIf you already clicked/shared information\nReporting options\n` +
    `Rules: never repeat personal information visible in the image (refer to it as "your details"); never invent reporting websites; if none are known, say to use the platform's verified reporting resources; be calm and non-judgmental.`;

  let reply = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  try {
    const result = await provider.chat({
      model: MODELS.vision,
      messages: [{ role: "user", content: prompt }],
      imageDataUrl: dataUrl,
      maxTokens: 1200,
    });
    reply = result.content;
    usage = result.usage;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    await logUsage(sb, user.id, MODELS.vision, "scan", {}, Date.now() - started, "error");
    return jsonResponse({ error: "AI_GATEWAY_ERROR", detail: msg }, 502);
  }

  const riskMatch = reply.match(/\b(critical|high|medium|low)\b/i);
  const risk = (riskMatch ? riskMatch[1].toLowerCase() : "unknown") as "low" | "medium" | "high" | "critical" | "unknown";
  const confMatch = reply.match(/(\d{1,3})\s*%/);
  const confidence = confMatch ? Math.min(100, parseInt(confMatch[1], 10)) / 100 : 0;

  const { data: analysis, error: insErr } = await sb
    .from("security_analyses")
    .insert({
      user_id: user.id,
      analysis_type: "screenshot",
      input_reference: storagePath,
      risk_level: risk,
      confidence,
      findings: { reply, width: check.width, height: check.height, mime: check.mime, size: check.size },
      recommendation: reply.slice(0, 2000),
      redaction_applied: false,
    })
    .select("id")
    .single();

  if (insErr) return jsonResponse({ error: "ANALYSIS_STORE_FAILED" }, 500);

  await logUsage(sb, user.id, MODELS.vision, "scan", usage, Date.now() - started, "ok");
  return jsonResponse({ analysis_id: analysis.id, risk_level: risk, confidence, reply });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { user, error } = await getUser(req);
    if (error || !user) return jsonResponse({ error: "UNAUTHENTICATED" }, 401);

    const sb = adminClient();
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "chat") return await handleChat(sb, user, body);
    if (action === "scan") return await handleScan(sb, user, body);
    return jsonResponse({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    return jsonResponse({ error: "INTERNAL", detail: msg.slice(0, 300) }, 500);
  }
});
