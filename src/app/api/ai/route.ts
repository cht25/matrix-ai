// =============================================================================
// MATRIX AI — AI Gateway (Next.js route handler — Firebase port)
//
// The ONLY way the frontend talks to an AI provider. Pipeline:
//   Auth → rate limit → PII redaction → safety classification → prompt/RAG
//   → automatic routing (Groq general, OpenRouter Nemotron coding/Agent)
//   → output validation → artifact parsing → store allowed response → return
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
import { adminDb, adminAuth, nowTs } from "@/lib/firebase/admin";
import { verifySession, type SessionUser } from "@/lib/firebase/session";
import { redactPII, containsCredentials, leakedPII } from "@/lib/ai/pii";
import { classify } from "@/lib/ai/domain";
import { createProvider, MODELS, type AIMessage, type AIProvider } from "@/lib/ai/groq";
import { AI_CONFIG, createAIRoutes, logAIConfiguration, type AIRouteTarget } from "@/lib/ai/config";
import { completeWithFallback, streamWithFallback } from "@/lib/ai/executor";
import { AIProviderError, logProviderFailure, providerPublicCode } from "@/lib/ai/provider-error";
import { agentGenerationIncomplete, formatAttachmentContext, isCodingRequest, parseAgentResponse, safeAgentPath, type AgentFile, type ChatMode, type TextAttachment } from "@/lib/ai/agent";
import { buildAgentSystemMessages, buildSystemMessages, validateOutput, buildSummaryPrompt } from "@/lib/ai/prompts";
import { isThemeIntent, THEME_GALLERY_REPLY_BN, THEME_GALLERY_REPLY_EN } from "@/lib/theme-intent";
import { validateImageUpload } from "@/lib/ai/upload-validation";
import { ragSearch } from "@/lib/server/rpc";
import { downloadImage } from "@/lib/server/cloudinary";
import { descDoc } from "@/lib/server/sort";
import { applyProjectFiles, ensureProject } from "@/lib/server/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RATE_LIMITS: Record<string, { perMinute: number; perDay: number }> = {
  chat: { perMinute: 20, perDay: 300 },
  scan: { perMinute: 5, perDay: 50 },
  summary: { perMinute: 10, perDay: 100 },
};

type Db = ReturnType<typeof adminDb>;

function json(obj: unknown, status = 200, requestId?: string) {
  return NextResponse.json(obj, {
    status,
    headers: requestId ? { "X-MATRIX-Request-ID": requestId } : undefined,
  });
}

function providerStatus(error: unknown): number {
  if (error instanceof AIProviderError) {
    if (error.type === "invalid_request") return 400;
    if (error.type === "timeout") return 504;
    if (error.type === "provider_unavailable" || error.type === "rate_limit" || error.type === "billing") return 503;
  }
  return 502;
}

function requestIdFrom(body: Record<string, unknown>): string {
  const value = typeof body.request_id === "string" ? body.request_id.trim() : "";
  return /^[a-zA-Z0-9._:-]{8,100}$/.test(value) ? value : crypto.randomUUID();
}

async function claimRequest(d: Db, userId: string, requestId: string): Promise<boolean> {
  try {
    await d.collection("ai_request_dedup").doc(`${userId}_${requestId}`).create({
      user_id: userId,
      request_id: requestId,
      created_at: nowTs(),
    });
    return true;
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? "").toLowerCase();
    if (code.includes("already") || code === "6") return false;
    // An idempotency log outage must not make the AI gateway unavailable.
    console.error("[MATRIX] AI request de-duplication check failed; continuing.", { requestId, code: code || "unknown" });
    return true;
  }
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
  // Equality-only query + in-memory windowing. A created_at inequality plus
  // two equality filters needs a composite index — missing indexes used to
  // 500 every chat request (FAILED_PRECONDITION). Fail *open* so a logging
  // glitch never blocks the assistant.
  const { perMinute, perDay } = RATE_LIMITS[kind];
  try {
    const snap = await d.collection("ai_usage_logs").where("user_id", "==", userId).get();
    const now = Date.now();
    let minute = 0;
    let day = 0;
    for (const doc of snap.docs) {
      if (doc.data().request_type !== kind) continue;
      const raw = doc.data().created_at as { toMillis?: () => number; toDate?: () => Date } | string | undefined;
      const t =
        typeof raw === "object" && raw?.toMillis ? raw.toMillis() :
        typeof raw === "object" && raw?.toDate ? raw.toDate().getTime() :
        typeof raw === "string" ? Date.parse(raw) : 0;
      if (!t) continue;
      if (now - t < 60_000) minute++;
      if (now - t < 86_400_000) day++;
    }
    if (minute >= perMinute) return { ok: false, message: "RATE_LIMITED_MINUTE" };
    if (day >= perDay) return { ok: false, message: "RATE_LIMITED_DAY" };
    return { ok: true };
  } catch (err) {
    console.error("[MATRIX] Rate-limit check failed — allowing the request.", err);
    return { ok: true };
  }
}

async function logUsage(d: Db, userId: string, model: string, requestType: string, tokenUsage: unknown, latencyMs: number, status: string, requestId?: string) {
  try {
    await d.collection("ai_usage_logs").add({
      user_id: userId,
      model,
      request_type: requestType,
      token_usage: tokenUsage ?? {},
      latency_ms: latencyMs,
      status,
      ...(requestId ? { request_id: requestId } : {}),
      created_at: nowTs(),
    });
  } catch (error) {
    // Observability must not turn a successful provider response into a chat
    // failure. Keep the diagnostic small and do not log request contents.
    console.error("[MATRIX] AI usage log write failed.", { requestId: requestId ?? "none", error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
  }
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
  providerName?: string;
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
  mode: ChatMode;
  codingDetected: boolean;
  files?: AgentFile[];
  projectId?: string | null;
  requestId?: string;
}) {
  const {
    provider, providerName, user, conversationId, isTemporary, message, redactedMessage, reply,
    history, redaction, started, model, mode, codingDetected, files = [], projectId = null, requestId,
  } = opts;
  const convRef = d.collection("conversations").doc(conversationId);

  await convRef.collection("messages").add({
    role: "assistant",
    content: reply,
    metadata: {
      mode,
      model,
      ...(providerName ? { provider: providerName } : {}),
      coding_detected: codingDetected,
      ...(files.length ? { artifacts: files } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    },
    created_at: nowTs(),
  });
  await convRef.set({ updated_at: nowTs(), mode }, { merge: true });

  // Rolling summary for permanent chats (spec §21) — best-effort.
  if (!isTemporary) {
    const count = await countUserMessages(d, conversationId);
    if (count >= 10 && count % 10 === 0) {
      try {
        const sum = await provider.chat({ model, messages: [{ role: "user", content: buildSummaryPrompt(history.slice(-6)) }], maxTokens: 300, requestId });
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
          model,
          messages: [
            { role: "system", content: "Extract at most one safe, useful long-term preference or context fact that would improve future help (for example, preferred language, skill level, device, or project stack). Return ONLY the fact, or NONE if nothing is worth remembering. Never output passwords, codes, tokens, IDs, emails, addresses or payment information." },
            { role: "user", content: redactedMessage },
          ],
          maxTokens: 60,
          requestId,
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

  await logUsage(d, user.uid, model, "chat", {}, Date.now() - started, "ok", requestId);
}

function normaliseTextAttachments(value: unknown): TextAttachment[] {
  if (!Array.isArray(value)) return [];
  const files: TextAttachment[] = [];
  let total = 0;
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? safeAgentPath(raw.name) : null;
    const content = typeof raw.content === "string" ? raw.content : "";
    if (!name || !content || content.length > 250_000 || total + content.length > 600_000) continue;
    total += content.length;
    files.push({ name, content, type: typeof raw.type === "string" ? raw.type.slice(0, 100) : undefined });
  }
  return files;
}

async function handleChat(d: Db, user: SessionUser, body: Record<string, unknown>) {
  const started = Date.now();
  const requestId = requestIdFrom(body);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
  const isTemporary = body.is_temporary === true;
  const requestedMode: ChatMode = body.mode === "agent" && !isTemporary ? "agent" : "general";
  let mode = requestedMode;
  const attachments = normaliseTextAttachments(body.attachments);
  const requestedStream = body.stream === true;
  let wantStream = requestedStream && mode !== "agent";
  const regenerate = body.regenerate === true;
  const reuseUser = body.reuse_user === true || regenerate;
  const preferredLanguage: "en" | "bn" | undefined = body.language === "bn" ? "bn" : body.language === "en" ? "en" : undefined;

  if (mode !== "agent" && isThemeIntent(message)) {
    let convId = conversationId;
    if (!convId) {
      const created = await d.collection("conversations").add({
        user_id: user.uid,
        title: message.replace(/\s+/g, " ").slice(0, 60),
        mode: "general",
        is_temporary: isTemporary,
        summary: "",
        archived_at: null,
        deleted_at: null,
        created_at: nowTs(),
        updated_at: nowTs(),
      });
      convId = created.id;
    }
    const reply = preferredLanguage === "bn" || /[\u0980-\u09ff]/.test(message) ? THEME_GALLERY_REPLY_BN : THEME_GALLERY_REPLY_EN;
    if (!reuseUser) {
      await d.collection("conversations").doc(convId).collection("messages").add({
        role: "user", content: message, metadata: { mode: "general" }, created_at: nowTs(),
      });
    }
    await d.collection("conversations").doc(convId).collection("messages").add({
      role: "assistant", content: reply, metadata: { action: "theme_gallery" }, created_at: nowTs(),
    });
    return json({ reply, conversation_id: convId, theme_gallery: true, metadata: { action: "theme_gallery" } });
  }

  if (!message) return json({ error: "MESSAGE_REQUIRED" }, 400, requestId);
  if (message.length > 12_000) return json({ error: "MESSAGE_TOO_LONG" }, 400, requestId);
  if (reuseUser && !conversationId) return json({ error: "CONVERSATION_NOT_FOUND" }, 404, requestId);

  if (!(await claimRequest(d, user.uid, requestId))) {
    return json({ error: "DUPLICATE_REQUEST" }, 409, requestId);
  }

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
    mode = conv.data()!.mode === "agent" && !isTemporary ? "agent" : "general";
    wantStream = requestedStream && mode !== "agent";
  } else {
    const title = message.replace(/\s+/g, " ").slice(0, 60);
    const created = await d.collection("conversations").add({
      user_id: user.uid,
      title,
      mode,
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

  // --- store original privately; only redacted text reaches AI providers ------
  const redaction = redactPII(message);
  if (!reuseUser) {
    await convRef.collection("messages").add({
      role: "user",
      content: message,
      metadata: {
        pii_redacted: !redaction.safe,
        detected: redaction.detected.map((x) => x.type),
        mode,
        attachment_names: attachments.map((file) => file.name),
      },
      created_at: nowTs(),
    });
  }

  // --- classification ----------------------------------------------------------
  // Normal and unknown-language questions are never blocked. Classification is
  // used for topic-aware retrieval and clearly harmful operational requests only.
  const classification = classify(redaction.redacted);
  if (classification.harmful) {
    await logSafety(d, user.uid, "harmful_request", classification.harmful_category ?? "harmful");
    await logUsage(d, user.uid, "none", "chat", {}, Date.now() - started, "refused", requestId);
    const refusal = preferredLanguage === "bn" || /[\u0980-\u09ff]/.test(message)
      ? "কারও ক্ষতি করা বা অনুমতি ছাড়া অন্যের সিস্টেমে ঢোকার নির্দেশনা আমি দিতে পারি না। তবে একই বিষয় নিরাপদভাবে শেখা, নিজের ডিভাইস বা অ্যাকাউন্ট রক্ষা করা, সমস্যা থেকে পুনরুদ্ধার করা, অথবা বৈধ ল্যাবে অনুশীলনে আমি সাহায্য করতে পারি।"
      : classification.refusal!;
    await convRef.collection("messages").add({ role: "assistant", content: refusal, metadata: {}, created_at: nowTs() });
    return json({ reply: refusal, conversation_id: convId, refused: true, reason: "harmful" });
  }
  if (redaction.detected.some((x) => x.type === "otp" || x.type === "password")) {
    await logSafety(d, user.uid, "pii_detected", redaction.detected.map((x) => x.type).join(","));
  }
  if (containsCredentials(redaction.redacted)) {
    await logSafety(d, user.uid, "pii_detected", "credential-sharing attempt blocked");
  }

  // --- prompt construction + automatic model routing --------------------------
  // Agent mode and obvious coding work use OpenRouter first. A transient
  // OpenRouter failure is retried once, then safely moved to Groq. General
  // conversation remains Groq-only so routing is deterministic.
  const codingDetected = mode === "agent" || isCodingRequest(message, attachments);
  const preferFallback = body.prefer_fallback === true;
  const targets = createAIRoutes(codingDetected, preferFallback);
  const selectedModel = targets[0]?.model ?? (codingDetected ? AI_CONFIG.coding.model : AI_CONFIG.general.model);
  if (!targets.length) {
    await logUsage(d, user.uid, "none", "chat", {}, Date.now() - started, "error", requestId);
    return json({ error: codingDetected ? "CODING_MODEL_NOT_CONFIGURED" : "AI_GATEWAY_NOT_CONFIGURED", conversation_id: convId }, 503, requestId);
  }

  // Context: summary + recent messages + safe memory + RAG
  const [summaryDoc, recentSnap, profileDoc] = await Promise.all([
    d.collection("conversation_summaries").doc(convId).get(),
    convRef.collection("messages").get(),
    d.collection("profiles").doc(user.uid).get(),
  ]);
  const history: AIMessage[] = [];
  if (summaryDoc.data()?.summary) history.push({ role: "system", content: "Summary of the earlier conversation:\n" + summaryDoc.data()!.summary });
  const recentDocs = recentSnap.docs.sort(descDoc("created_at")).slice(0, 10).reverse();
  for (const m of recentDocs) {
    const role = m.data().role;
    if (role === "user") history.push({ role, content: redactPII(String(m.data().content ?? "")).redacted });
    if (role === "assistant") history.push({ role, content: String(m.data().content ?? "") });
  }
  // The current user turn was stored before this read. Remove it from history
  // because the redacted latest turn is appended once below. This also avoids
  // duplicating the user turn on Retry/Regenerate.
  while (history.length && history[history.length - 1]?.role === "user") history.pop();
  if (regenerate) {
    while (history.length && history[history.length - 1]?.role === "assistant") history.pop();
    while (history.length && history[history.length - 1]?.role === "user") history.pop();
  }
  const memories = await loadSafeMemories(d, user.uid);
  if (memories) history.push({ role: "system", content: "Safe context about the user (never repeat back verbatim):\n" + memories });

  const rag = mode === "agent" ? "" : await buildRagContext(d, redaction.redacted, profileDoc.data()?.country ?? null);
  const safeAttachments = attachments.map((file) => {
    const result = redactPII(file.content);
    return { ...file, content: result.redacted };
  });
  const attachmentContext = formatAttachmentContext(safeAttachments);

  const messages: AIMessage[] = [
    ...(mode === "agent" ? buildAgentSystemMessages(preferredLanguage) : buildSystemMessages(rag, false, preferredLanguage)),
    ...history,
    ...(attachmentContext ? [{ role: "system" as const, content: attachmentContext }] : []),
    ...(codingDetected && mode === "general" ? [{
      role: "system" as const,
      content: "A coding task was automatically detected and is being handled by MATRIX coding routing. Give accurate, complete code and filenames, but do not emit MATRIX_FILE artifact blocks: live preview and GitHub push are available only in Agent mode.",
    }] : []),
    { role: "user", content: redaction.redacted },
  ];

  // --- Provider streaming path ------------------------------------------------
  if (wantStream && mode !== "agent" && targets[0]?.client.streamChat) {
    let done = false;
    let full = "";
    let activeTarget: AIRouteTarget = targets[0];
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
          emit({ conversation_id: convId, mode, model: activeTarget.model, provider: activeTarget.provider, coding_detected: codingDetected });
          for await (const item of streamWithFallback(
            targets,
            {
              messages,
              temperature: codingDetected ? 0.3 : 0.5,
              maxTokens: codingDetected ? 3200 : 1600,
              requestId,
            },
            (target, fallback) => {
              activeTarget = target;
              if (fallback) emit({ model: target.model, provider: target.provider, fallback: true });
            },
          )) {
            const delta = item.delta;
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
          if (!full.trim()) throw new Error("EMPTY_AI_RESPONSE");
          done = true;
          await finalizeChat(d, {
            provider: activeTarget.client, providerName: activeTarget.provider, user, conversationId: convId, isTemporary, message,
            redactedMessage: redaction.redacted, reply: full, history, redaction, started,
            model: activeTarget.model, mode, codingDetected, requestId,
          });
          emit({
            done: true,
            conversation_id: convId,
            pii_redacted: !redaction.safe,
            mode,
            model: activeTarget.model,
            provider: activeTarget.provider,
            coding_detected: codingDetected,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "stream error";
          if (msg !== "CLIENT_DISCONNECTED") {
            logProviderFailure(e, requestId);
            await logUsage(d, user.uid, activeTarget.model, "chat", {}, Date.now() - started, "error", requestId);
          }
          // Persist whatever actually streamed so Stop / disconnect doesn't
          // throw the reply away — the client can keep it on screen too.
          if (full && !done) {
            try {
              await finalizeChat(d, {
                provider: activeTarget.client, providerName: activeTarget.provider, user, conversationId: convId, isTemporary, message,
                redactedMessage: redaction.redacted, reply: full, history, redaction, started,
                model: activeTarget.model, mode, codingDetected, requestId,
              });
              done = true;
            } catch {
              /* best-effort persist */
            }
          }
          if (msg !== "CLIENT_DISCONNECTED") {
            try {
              emit({ error: providerPublicCode(e), conversation_id: convId });
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
        "X-MATRIX-Request-ID": requestId,
      },
    });
  }

  // --- Non-streaming path (Agent returns structured file artifacts) ------------
  let rawReply: string;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let activeTarget: AIRouteTarget = targets[0];
  try {
    const result = await completeWithFallback(targets, {
      messages,
      temperature: mode === "agent" ? 0.25 : 0.5,
      maxTokens: mode === "agent" ? 16384 : codingDetected ? 4096 : 1600,
      requestId,
    });
    activeTarget = result.target;
    rawReply = result.response.content;
    usage = result.response.usage;

    // Continue when the model hits the token cap mid-file so Agent does not
    // return truncated HTML/JS. Up to 3 extra turns, concatenated.
    if (mode === "agent") {
      let incomplete = result.response.finishReason === "length" || agentGenerationIncomplete(rawReply);
      let continuations = 0;
      while (incomplete && continuations < 3) {
        continuations += 1;
        const continuation = await completeWithFallback(
          [activeTarget, ...targets.filter((target) => target !== activeTarget)],
          {
            messages: [
              ...messages,
              { role: "assistant", content: rawReply },
              {
                role: "user",
                content:
                  "Continue from the exact character where you stopped. Do not restart the answer. Finish every open MATRIX_FILE block with complete file contents and <<<END_MATRIX_FILE>>>. No placeholders or omitted sections.",
              },
            ],
            temperature: 0.2,
            maxTokens: 16384,
            requestId,
          },
        );
        activeTarget = continuation.target;
        const cont = continuation.response;
        if (!cont.content.trim()) break;
        rawReply += cont.content;
        usage = {
          promptTokens: usage.promptTokens + cont.usage.promptTokens,
          completionTokens: usage.completionTokens + cont.usage.completionTokens,
          totalTokens: usage.totalTokens + cont.usage.totalTokens,
        };
        incomplete = cont.finishReason === "length" || agentGenerationIncomplete(rawReply);
      }
    }
  } catch (error) {
    logProviderFailure(error, requestId);
    await logUsage(d, user.uid, activeTarget?.model ?? selectedModel, "chat", {}, Date.now() - started, "error", requestId);
    return json({ error: providerPublicCode(error), conversation_id: convId }, providerStatus(error), requestId);
  }

  let files: AgentFile[] = [];
  const check = validateOutput(rawReply);
  if (!check.ok) {
    await logSafety(d, user.uid, "output_blocked", check.reason ?? "unknown");
    rawReply = "I'm sorry — I can only provide defensive, safe guidance. Tell me the legitimate goal and I'll help with a safe implementation.";
  }
  const leaks = leakedPII(message, rawReply);
  if (leaks.length > 0) {
    await logSafety(d, user.uid, "pii_detected", "response echoed PII");
    for (const l of leaks) rawReply = rawReply.replaceAll(l, "[redacted]");
  }

  let reply = rawReply.trim();
  if (mode === "agent" && check.ok) {
    const parsed = parseAgentResponse(rawReply);
    reply = parsed.reply;
    files = parsed.files;
  }

  // Agent artifacts are persisted to a per-conversation project here on the
  // server (single source of truth) so the workspace always reopens the same
  // project instead of creating a new one each time. Best-effort: a project
  // write failure never fails the chat — the files still travel in `artifacts`.
  let projectId: string | null = null;
  if (mode === "agent" && files.length) {
    try {
      const proj = await ensureProject(d, user, { conversation_id: convId, title: (message || "Agent project").slice(0, 80) });
      await applyProjectFiles(d, user, { project_id: proj.id, files, source: "agent" });
      projectId = proj.id;
    } catch {
      // best-effort (e.g. project limit) — reply still returns the files
    }
  }

  await finalizeChat(d, {
    provider: activeTarget.client, providerName: activeTarget.provider, user, conversationId: convId, isTemporary, message,
    redactedMessage: redaction.redacted, reply, history, redaction, started,
    model: activeTarget.model, mode, codingDetected, files, projectId, requestId,
  });
  return json({
    reply,
    files,
    conversation_id: convId,
    project_id: projectId,
    refused: false,
    pii_redacted: !redaction.safe,
    mode,
    model: activeTarget.model,
    provider: activeTarget.provider,
    fallback: codingDetected && activeTarget.provider === "Groq",
    coding_detected: codingDetected,
    usage,
    request_id: requestId,
  }, 200, requestId);
}

// ---------------------------------------------------------------------------
// Scan action (screenshot analysis, spec §14)
// ---------------------------------------------------------------------------
async function handleScan(d: Db, user: SessionUser, body: Record<string, unknown>) {
  const started = Date.now();
  const requestId = requestIdFrom(body);
  const storagePath = typeof body.storage_path === "string" ? body.storage_path.trim() : "";
  if (!storagePath) return json({ error: "STORAGE_PATH_REQUIRED" }, 400);

  // Ownership: files must live in the user's own Cloudinary folder.
  if (!storagePath.startsWith(`security-screenshots/${user.uid}/`)) {
    await logSafety(d, user.uid, "safety_refusal", "storage path ownership violation");
    return json({ error: "STORAGE_OWNERSHIP_VIOLATION" }, 403);
  }

  const rate = await checkRateLimit(d, user.uid, "scan");
  if (!rate.ok) return json({ error: rate.message }, 429);

  // Private (authenticated) asset — bytes only via a server-signed URL.
  const fileBuffer = await downloadImage(storagePath);
  if (!fileBuffer) return json({ error: "FILE_NOT_FOUND" }, 404);
  const bytes = new Uint8Array(fileBuffer);

  const check = validateImageUpload(bytes, null);
  if (!check.ok) {
    await logSafety(d, user.uid, "safety_refusal", "invalid upload: " + check.error);
    return json({ error: check.error }, 400);
  }

  const provider = createProvider();
  if (!provider) return json({ error: "AI_GATEWAY_NOT_CONFIGURED" }, 503, requestId);

  const dataUrl = `data:${check.mime};base64,${Buffer.from(bytes).toString("base64")}`;

  const agentReference = body.purpose === "agent_reference";
  const prompt = agentReference
    ? `Describe this image as implementation context for a software coding agent. Identify the visible layout, hierarchy, components, spacing, colours, typography, states, text purpose and responsive clues. If it is an object rather than an interface, describe the object's relevant visible properties and what the user may want to reproduce. Be precise and concise. Never transcribe personal information, access tokens, account details or private messages; use neutral placeholders instead. Do not give cybersecurity risk advice unless the image itself is a security warning.`
    : `Analyse this screenshot for a teen cybersecurity education platform. The user uploaded it to ask whether it is suspicious. ` +
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
      requestId,
    });
    reply = result.content;
    usage = result.usage;
  } catch (e) {
    logProviderFailure(e, requestId);
    await logUsage(d, user.uid, MODELS.vision, "scan", {}, Date.now() - started, "error", requestId);
    return json({ error: providerPublicCode(e) }, providerStatus(e), requestId);
  }

  if (agentReference) {
    await logUsage(d, user.uid, MODELS.vision, "scan", usage, Date.now() - started, "ok", requestId);
    return json({ reply, reference: true, request_id: requestId }, 200, requestId);
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

  await logUsage(d, user.uid, MODELS.vision, "scan", usage, Date.now() - started, "ok", requestId);
  return json({ analysis_id: analysis.id, risk_level: risk, confidence, reply, request_id: requestId }, 200, requestId);
}

// ---------------------------------------------------------------------------
// Health (unauthenticated, honest): reports whether the gateway can actually
// reach the AI provider. Used by the UI status indicator and /api/health.
// ---------------------------------------------------------------------------
async function handleHealth(mode: ChatMode = "general") {
  const targets = createAIRoutes(mode === "agent");
  if (!targets.length) return json({ status: "unconfigured", mode }, 503);
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    if (await target.client.healthCheck()) {
      return json({
        status: "online",
        mode,
        provider: target.provider,
        chat_model: target.model,
        fallback: i > 0,
      });
    }
  }
  return json({ status: "unavailable", mode, chat_model: targets[0].model }, 503);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  logAIConfiguration();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action;

    // Health is intentionally unauthenticated (no user JWT required).
    if (action === "health") return await handleHealth(body.mode === "agent" ? "agent" : "general");

    const user = await getUser(req);
    if (!user) return json({ error: "UNAUTHENTICATED" }, 401);

    const d = adminDb();
    if (action === "chat") return await handleChat(d, user, body);
    if (action === "scan") return await handleScan(d, user, body);
    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    logProviderFailure(e, requestId);
    return json({ error: "INTERNAL" }, 500, requestId);
  }
}
