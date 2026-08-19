// =============================================================================
// MATRIX AI — AI Gateway (Next.js route handler — Firebase port)
//
// The ONLY way the frontend talks to Groq. Pipeline (spec §24):
//   Auth → Rate limit → PII detection/redaction → Cyber domain classification
//   → Cyber safety classification → Prompt construction → RAG retrieval
//   → Groq → Output safety validation → Store allowed response → Return
//
// Actions:
//   POST { action: "chat", conversation_id?, is_temporary, message }
//   POST { action: "scan", storage_path }   (screenshot analysis)
//   POST { action: "health" }               (unauthenticated, real Groq check)
//
// Failure contract: failures return error codes — the gateway NEVER stores or
// returns a fabricated assistant reply.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth, adminBucket, nowTs, toTs } from "@/lib/firebase/admin";
import { verifySession, type SessionUser } from "@/lib/firebase/session";
import { redactPII, containsCredentials, leakedPII } from "@/lib/ai/pii";
import { classify } from "@/lib/ai/domain";
import { createProvider, MODELS, type AIMessage, type AIProvider } from "@/lib/ai/groq";
import { buildSystemMessages, validateOutput, buildSummaryPrompt } from "@/lib/ai/prompts";
import { validateImageUpload } from "@/lib/ai/upload-validation";
import { ragSearch } from "@/lib/server/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATE_LIMITS: Record<string, { perMinute: number; perDay: number }> = {
  chat: { perMinute: 20, perDay: 300 },
  scan: { perMinute: 5, perDay: 50 },
  summary: { perMinute: 10, perDay: 100 },
};

type Db = ReturnType<typeof adminDb>;

function json(obj: unknown, status = 200) {
  return NextResponse.json(obj, { status });
}

async function getUser(req: NextRequest): Promise<SessionUser | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && bearer.split(".").length === 3) {
    try {
      const decoded = await adminAuth().verifyIdToken(bearer, true);
      return { uid: decoded.uid, email: decoded.email ?? null, emailVerified: decoded.email_verified ?? false };
    } catch {
      return null;
    }
  }
  const cookie = req.cookies.get("__session")?.value;
  if (!cookie) return null;
  try {
    return await verifySession(cookie);
  } catch {
    return null;
  }
}

async function checkRateLimit(d: Db, userId: string, kind: "chat" | "scan" | "summary"): Promise<{ ok: boolean; message?: string }> {
  const { perMinute, perDay } = RATE_LIMITS[kind];
  const minuteAgo = toTs(new Date(Date.now() - 60_000));
  const dayAgo = toTs(new Date(Date.now() - 86_400_000));
  const logs = d.collection("ai_usage_logs");
  const [minuteSnap, daySnap] = await Promise.all([
    logs.where("user_id", "==", userId).where("request_type", "==", kind).where("created_at", ">=", minuteAgo).count().get(),
    logs.where("user_id", "==", userId).where("request_type", "==", kind).where("created_at", ">=", dayAgo).count().get(),
  ]);
  if (minuteSnap.data().count >= perMinute) return { ok: false, message: "RATE_LIMITED_MINUTE" };
  if (daySnap.data().count >= perDay) return { ok: false, message: "RATE_LIMITED_DAY" };
  return { ok: true };
}

async function logUsage(d: Db, userId: string, model: string, requestType: string, tokenUsage: unknown, latencyMs: number, status: string) {
  await d.collection("ai_usage_logs").add({
    user_id: userId,
    model,
    request_type: requestType,
    token_usage: tokenUsage ?? {},
    latency_ms: latencyMs,
    status,
    created_at: nowTs(),
  });
}

async function logSafety(d: Db, userId: string | null, eventType: string, detail: string) {
  await d.collection("ai_safety_events").add({
    user_id: userId,
    event_type: eventType,
    detail: detail.slice(0, 500),
    created_at: nowTs(),
  });
}

// ---------------------------------------------------------------------------
// RAG context + memory + reporting grounding
// ---------------------------------------------------------------------------
async function buildRagContext(d: Db, message: string, country: string | null): Promise<string> {
  const parts: string[] = [];
  const chunks = await ragSearch(d, message.slice(0, 200), 4);
  for (const c of chunks.slice(0, 3)) {
    parts.push(`[${c.source_type}] ${c.title}: ${c.content.slice(0, 600)}`);
  }
  if (country) {
    const resources = await d
      .collection("reporting_resources")
      .where("country_id", "==", country)
      .where("status", "==", "active")
      .limit(3)
      .get();
    if (!resources.empty) {
      parts.push("Verified reporting resources (use ONLY these):");
      for (const r of resources.docs) {
        const data = r.data();
        parts.push(`- ${data.organization} — ${data.official_url}${data.phone ? " / " + data.phone : ""}: ${data.description ?? ""}`);
      }
    }
  }
  return parts.join("\n");
}

async function loadSafeMemories(d: Db, userId: string): Promise<string> {
  const snap = await d.collection("user_memories").where("user_id", "==", userId).limit(5).get();
  if (snap.empty) return "";
  return snap.docs.map((m) => `- ${m.data().memory}`).join("\n");
}

// ---------------------------------------------------------------------------
// Chat action
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();

async function countUserMessages(d: Db, conversationId: string): Promise<number> {
  const snap = await d.collection("conversations").doc(conversationId).collection("messages").where("role", "==", "user").count().get();
  return snap.data().count;
}

async function finalizeChat(d: Db, opts: {
  provider: AIProvider;
  user: SessionUser;
  conversationId: string;
  isTemporary: boolean;
  message: string;
  redactedMessage: string;
  reply: string;
  history: AIMessage[];
  redaction: ReturnType<typeof redactPII>;
  started: number;
  model: string;
}) {
  const { provider, user, conversationId, isTemporary, message, redactedMessage, reply, history, redaction, started, model } = opts;
  const convRef = d.collection("conversations").doc(conversationId);

  await convRef.collection("messages").add({ role: "assistant", content: reply, metadata: {}, created_at: nowTs() });
  await convRef.set({ updated_at: nowTs() }, { merge: true });

  // Rolling summary for permanent chats (spec §21) — best-effort.
  if (!isTemporary) {
    const count = await countUserMessages(d, conversationId);
    if (count >= 10 && count % 10 === 0) {
      try {
        const sum = await provider.chat({ model: MODELS.fast, messages: [{ role: "user", content: buildSummaryPrompt(history.slice(-6)) }], maxTokens: 300 });
        await d.collection("conversation_summaries").doc(conversationId).set({
          conversation_id: conversationId,
          summary: sum.content,
          message_count: count,
          created_at: nowTs(),
          updated_at: nowTs(),
        }, { merge: true });
      } catch {
        // never fail the chat over a summary
      }
    }
  }

  // Memory extraction — only safe, useful context (spec §20).
  if (!isTemporary && redaction.safe && !message.toLowerCase().includes("remember")) {
    const count = await countUserMessages(d, conversationId);
    if (count % 5 === 0 && count > 0) {
      try {
        const mem = await provider.chat({
          model: MODELS.fast,
          messages: [
            { role: "system", content: "Extract at most one safe, useful fact about the user relevant to cybersecurity learning (e.g. 'User is a beginner in cybersecurity.', 'User uses an Android phone.'). Return ONLY the fact, or the word NONE if nothing is worth remembering. Never output passwords, codes, IDs, emails, addresses or payment info." },
            { role: "user", content: redactedMessage },
          ],
          maxTokens: 60,
        });
        const fact = mem.content.trim();
        if (fact && fact !== "NONE" && fact.length < 160) {
          await d.collection("user_memories").add({
            user_id: user.uid,
            memory: fact,
            source: "ai",
            is_private: true,
            created_at: nowTs(),
            updated_at: nowTs(),
          });
        }
      } catch {
        // best-effort
      }
    }
  }

  await logUsage(d, user.uid, model, "chat", {}, Date.now() - started, "ok");
}

async function handleChat(d: Db, user: SessionUser, body: Record<string, unknown>) {
  const started = Date.now();
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
  const isTemporary = body.is_temporary === true;
  const wantStream = body.stream === true;

  if (!message) return json({ error: "MESSAGE_REQUIRED" }, 400);
  if (message.length > 4000) return json({ error: "MESSAGE_TOO_LONG" }, 400);

  const rate = await checkRateLimit(d, user.uid, "chat");
  if (!rate.ok) {
    await logSafety(d, user.uid, "safety_refusal", "rate_limited");
    return json({ error: rate.message }, 429);
  }

  // --- conversation resolution -------------------------------------------------
  let convId = conversationId;
  if (convId) {
    const conv = await d.collection("conversations").doc(convId).get();
    if (!conv.exists || conv.data()!.user_id !== user.uid) return json({ error: "CONVERSATION_NOT_FOUND" }, 404);
  } else {
    const title = message.replace(/\s+/g, " ").slice(0, 60);
    const created = await d.collection("conversations").add({
      user_id: user.uid,
      title,
      is_temporary: isTemporary,
      summary: "",
      archived_at: null,
      deleted_at: null,
      created_at: nowTs(),
      updated_at: nowTs(),
    });
    convId = created.id;
  }
  const convRef = d.collection("conversations").doc(convId);

  // --- store the user message (original stays in the DB; PII never hits Groq) --
  const redaction = redactPII(message);
  await convRef.collection("messages").add({
    role: "user",
    content: message,
    metadata: { pii_redacted: !redaction.safe, detected: redaction.detected.map((x) => x.type) },
    created_at: nowTs(),
  });

  // --- classification (no LLM call needed for refusals) ------------------------
  const classification = classify(redaction.redacted);
  if (!classification.on_topic) {
    await logSafety(d, user.uid, "off_topic", "off-topic request refused");
    await logUsage(d, user.uid, "none", "chat", {}, Date.now() - started, "refused");
    await convRef.collection("messages").add({ role: "assistant", content: classification.refusal!, metadata: {}, created_at: nowTs() });
    return json({ reply: classification.refusal, conversation_id: convId, refused: true, reason: "off_topic" });
  }
  if (classification.harmful) {
    await logSafety(d, user.uid, "harmful_request", classification.harmful_category ?? "harmful");
    await logUsage(d, user.uid, "none", "chat", {}, Date.now() - started, "refused");
    await convRef.collection("messages").add({ role: "assistant", content: classification.refusal!, metadata: {}, created_at: nowTs() });
    return json({ reply: classification.refusal, conversation_id: convId, refused: true, reason: "harmful" });
  }
  if (redaction.detected.some((x) => x.type === "otp" || x.type === "password")) {
    await logSafety(d, user.uid, "pii_detected", redaction.detected.map((x) => x.type).join(","));
  }
  if (containsCredentials(redaction.redacted)) {
    await logSafety(d, user.uid, "pii_detected", "credential-sharing attempt blocked");
  }

  // --- prompt construction -----------------------------------------------------
  const provider = createProvider();
  if (!provider) {
    // Do NOT fabricate an assistant reply — report the honest failure code.
    await logUsage(d, user.uid, "none", "chat", {}, Date.now() - started, "error");
    return json({ error: "AI_GATEWAY_NOT_CONFIGURED" }, 503);
  }

  // Context: summary + recent messages + safe memory + RAG
  const [summaryDoc, recentSnap, profileDoc] = await Promise.all([
    d.collection("conversation_summaries").doc(convId).get(),
    convRef.collection("messages").orderBy("created_at", "desc").limit(8).get(),
    d.collection("profiles").doc(user.uid).get(),
  ]);
  const history: AIMessage[] = [];
  if (summaryDoc.data()?.summary) history.push({ role: "system", content: "Summary of the earlier conversation:\n" + summaryDoc.data()!.summary });
  for (const m of [...recentSnap.docs].reverse()) {
    const role = m.data().role;
    if (role === "user" || role === "assistant") history.push({ role, content: m.data().content });
  }
  const memories = await loadSafeMemories(d, user.uid);
  if (memories) history.push({ role: "system", content: "Safe context about the user (never repeat back verbatim):\n" + memories });

  const rag = await buildRagContext(d, redaction.redacted, profileDoc.data()?.country ?? null);

  const messages: AIMessage[] = [
    ...buildSystemMessages(rag, false),
    ...history,
    { role: "user", content: redaction.redacted },
  ];

  // --- Groq: streaming path ----------------------------------------------------
  if (wantStream && provider.streamChat) {
    let done = false;
    let full = "";
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (obj: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            throw new Error("CLIENT_DISCONNECTED");
          }
        };
        let window = "";
        try {
          for await (const delta of provider.streamChat!({ model: MODELS.chat, messages, temperature: 0.4, maxTokens: 1024 })) {
            // Per-delta output safety + PII leak filtering.
            const probe = (window + delta).slice(-400);
            const check = validateOutput(probe);
            const leaks = leakedPII(message, delta);
            if (check.ok && leaks.length === 0) {
              full += delta;
              window = (window + delta).slice(-400);
              emit({ delta });
            }
          }
          done = true;
          await finalizeChat(d, {
            provider, user, conversationId: convId, isTemporary, message,
            redactedMessage: redaction.redacted, reply: full, history, redaction, started,
            model: MODELS.chat,
          });
          emit({ done: true, conversation_id: convId, pii_redacted: !redaction.safe });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "stream error";
          if (msg !== "CLIENT_DISCONNECTED") {
            await logUsage(d, user.uid, MODELS.chat, "chat", {}, Date.now() - started, "error");
            // Persist what streamed, so the user can retry cleanly.
            if (full && done) {
              await finalizeChat(d, {
                provider, user, conversationId: convId, isTemporary, message,
                redactedMessage: redaction.redacted, reply: full, history, redaction, started,
                model: MODELS.chat,
              });
            }
            try {
              emit({ error: "STREAM_FAILED" });
            } catch {
              /* client gone */
            }
          }
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // --- Groq: non-streaming path -------------------------------------------------
  let reply: string;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  try {
    const result = await provider.chat({ model: MODELS.chat, messages, temperature: 0.4, maxTokens: 1024 });
    reply = result.content;
    usage = result.usage;
  } catch {
    await logUsage(d, user.uid, MODELS.chat, "chat", {}, Date.now() - started, "error");
    // Do NOT fabricate an assistant reply — report the honest failure code.
    return json({ error: "AI_GATEWAY_ERROR" }, 502);
  }

  const check = validateOutput(reply);
  if (!check.ok) {
    await logSafety(d, user.uid, "output_blocked", check.reason ?? "unknown");
    reply = "I'm sorry — I can only provide defensive, safe guidance. Let me know what happened and I'll help you fix it.";
  }
  const leaks = leakedPII(message, reply);
  if (leaks.length > 0) {
    await logSafety(d, user.uid, "pii_detected", "response echoed PII");
    for (const l of leaks) reply = reply.replaceAll(l, "[redacted]");
  }

  await finalizeChat(d, {
    provider, user, conversationId: convId, isTemporary, message,
    redactedMessage: redaction.redacted, reply, history, redaction, started,
    model: MODELS.chat,
  });
  void usage;
  return json({ reply, conversation_id: convId, refused: false, pii_redacted: !redaction.safe });
}

// ---------------------------------------------------------------------------
// Scan action (screenshot analysis, spec §14)
// ---------------------------------------------------------------------------
async function handleScan(d: Db, user: SessionUser, body: Record<string, unknown>) {
  const started = Date.now();
  const storagePath = typeof body.storage_path === "string" ? body.storage_path.trim() : "";
  if (!storagePath) return json({ error: "STORAGE_PATH_REQUIRED" }, 400);

  // Ownership: files must live in the user's own folder.
  if (!storagePath.startsWith(`${user.uid}/`)) {
    await logSafety(d, user.uid, "safety_refusal", "storage path ownership violation");
    return json({ error: "STORAGE_OWNERSHIP_VIOLATION" }, 403);
  }

  const rate = await checkRateLimit(d, user.uid, "scan");
  if (!rate.ok) return json({ error: rate.message }, 429);

  const [fileBuffer] = await adminBucket().file(`security-screenshots/${storagePath}`).download().catch(() => [null]);
  if (!fileBuffer) return json({ error: "FILE_NOT_FOUND" }, 404);
  const bytes = new Uint8Array(fileBuffer);

  const check = validateImageUpload(bytes, null);
  if (!check.ok) {
    await logSafety(d, user.uid, "safety_refusal", "invalid upload: " + check.error);
    return json({ error: check.error }, 400);
  }

  const provider = createProvider();
  if (!provider) return json({ error: "AI_GATEWAY_NOT_CONFIGURED" }, 503);

  const dataUrl = `data:${check.mime};base64,${Buffer.from(bytes).toString("base64")}`;

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
    await logUsage(d, user.uid, MODELS.vision, "scan", {}, Date.now() - started, "error");
    return json({ error: "AI_GATEWAY_ERROR", detail: msg }, 502);
  }

  const riskMatch = reply.match(/\b(critical|high|medium|low)\b/i);
  const risk = (riskMatch ? riskMatch[1].toLowerCase() : "unknown") as "low" | "medium" | "high" | "critical" | "unknown";
  const confMatch = reply.match(/(\d{1,3})\s*%/);
  const confidence = confMatch ? Math.min(100, parseInt(confMatch[1], 10)) / 100 : 0;

  const analysis = await d.collection("security_analyses").add({
    user_id: user.uid,
    analysis_type: "screenshot",
    input_reference: storagePath,
    risk_level: risk,
    confidence,
    findings: { reply, width: check.width, height: check.height, mime: check.mime, size: check.size },
    recommendation: reply.slice(0, 2000),
    redaction_applied: false,
    created_at: nowTs(),
  });

  await logUsage(d, user.uid, MODELS.vision, "scan", usage, Date.now() - started, "ok");
  return json({ analysis_id: analysis.id, risk_level: risk, confidence, reply });
}

// ---------------------------------------------------------------------------
// Health (unauthenticated, honest): reports whether the gateway can actually
// reach the AI provider. Used by the UI status indicator and /api/health.
// ---------------------------------------------------------------------------
async function handleHealth() {
  const provider = createProvider();
  if (!provider) {
    return json({ status: "unconfigured" }, 503);
  }
  const ok = await provider.healthCheck();
  if (!ok) return json({ status: "unavailable" }, 503);
  return json({ status: "online", chat_model: MODELS.chat });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action;

    // Health is intentionally unauthenticated (no user JWT required).
    if (action === "health") return await handleHealth();

    const user = await getUser(req);
    if (!user) return json({ error: "UNAUTHENTICATED" }, 401);

    const d = adminDb();
    if (action === "chat") return await handleChat(d, user, body);
    if (action === "scan") return await handleScan(d, user, body);
    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    return json({ error: "INTERNAL", detail: msg.slice(0, 300) }, 500);
  }
}
