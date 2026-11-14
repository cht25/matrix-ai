import { cancelAgentTask } from "@/lib/server/agent-tasks";
import { classifyAgentOutput, requestsClarificationFirst, type PendingAgentTask } from "@/lib/ai/agent-execution";
// =============================================================================
// MATRIX AI — AI Gateway (Next.js route handler — Firebase port)
//
// The ONLY way the frontend talks to an AI provider. Pipeline:
//   Auth → rate limit → PII redaction → safety classification → prompt/RAG
//   → the single MATRIX model, GPT OSS 120B (src/lib/ai/config.ts); the
//     request class only changes prompts, tools and limits — never the model
//   → output validation → artifact parsing → store allowed response → return
//
// Actions:
//   POST { action: "chat", conversation_id?, is_temporary, message }
//   POST { action: "scan", storage_path }   (422: the model cannot read images)
//   POST { action: "health" }               (unauthenticated, real Groq check)
//
// Failure contract: failures return error codes — the gateway NEVER stores or
// returns a fabricated assistant reply.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth, nowTs } from "@/lib/firebase/admin";
import { verifySession, type SessionUser } from "@/lib/firebase/session";
import { verifyDeviceCredential, DEVICE_TOKEN_PREFIX, deviceScopeResponse } from "@/lib/firebase/device-session";
import { redactPII, containsCredentials, leakedPII } from "@/lib/ai/pii";
import { classify } from "@/lib/ai/domain";
import { type AIMessage, type AIProvider, type AIProviderResponse } from "@/lib/ai/groq";
import { createAIRoutesFromDb, logAIConfiguration, type AIRouteTarget } from "@/lib/ai/config";
import { MATRIX_MODEL_ID, MATRIX_MODEL_LABEL } from "@/lib/ai/model";
import { completeWithModel, streamWithModel } from "@/lib/ai/executor";
import { resolvePool } from "@/lib/ai/models/pool";
import { modelLabel } from "@/lib/ai/models/registry";
import { planCollaboration } from "@/lib/ai/orchestrator/plan";
import { completeWithFallback, runCollaboration, separateAnswers, streamWithFallback } from "@/lib/ai/orchestrator/run";
import { AIProviderError, logGatewayFailure, logProviderFailure, providerPublicCode } from "@/lib/ai/provider-error";
import { stripReasoningContent } from "@/lib/ai/reasoning";
import { formatAttachmentContext, isCodingRequest, safeAgentPath, type AgentFile, type ChatMode, type TextAttachment } from "@/lib/ai/agent";
import type { WorkingStep } from "@/lib/chat-messages";
import { detectBuildIntent, shouldRunBuildPipeline } from "@/lib/ai/build-intent";
import { requestChatMode } from "@/lib/ai/execution-policy";
import { computeAnalytics } from "@/lib/ai/pipeline";
import { generateImage, imageErrorCode } from "@/lib/ai/image/generate";
import { isImageGenerationConfigured } from "@/lib/ai/image/config";
import { buildModeSystemMessages, validateOutput, buildSummaryPrompt } from "@/lib/ai/prompts";
import { isModelLane, isStrategy, type ExplainStyle, type StudyLevel } from "@/lib/ai/modes";
import { decideRoute, planOrchestrator } from "@/lib/ai/router";
import { isThemeIntent, THEME_GALLERY_REPLY_BN, THEME_GALLERY_REPLY_EN } from "@/lib/theme-intent";
import { validateImageUpload } from "@/lib/ai/upload-validation";
import { ragSearch } from "@/lib/server/rpc";
import { downloadImage } from "@/lib/server/cloudinary";
import { descDoc } from "@/lib/server/sort";
import { executeAgentTool, modelCallableTools, recordAgentToolSelection } from "@/lib/server/tool-gateway";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Sanitized, user-safe description of the LAST provider failure after every
 * configured route was tried. Never includes request content or credentials. */
function providerDiagnostic(error: unknown, routesTried: number): { diagnostic?: { provider: string; model: string; type: string; status: number | null; detail: string; routes_tried: number } } {
  if (!(error instanceof AIProviderError)) return {};
  return { diagnostic: { provider: error.provider, model: error.model, type: error.type, status: error.status, detail: error.detail.slice(0, 180), routes_tried: routesTried } };
}

// High ceilings so MATRIX does not invent a product quota. Real provider
// 429s still surface as AI_PROVIDER_RATE_LIMITED.
const RATE_LIMITS: Record<string, { perMinute: number; perDay: number }> = {
  chat: { perMinute: 120, perDay: 5000 },
  scan: { perMinute: 30, perDay: 500 },
  summary: { perMinute: 40, perDay: 1000 },
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
  if (bearer?.startsWith(DEVICE_TOKEN_PREFIX)) {
    try { return await verifyDeviceCredential(adminDb(), bearer); } catch { return null; }
  }
  if (bearer && bearer.split(".").length === 3) {
    try {
      const decoded = await adminAuth().verifyIdToken(bearer, true);
      return { uid: decoded.uid, email: decoded.email ?? null, emailVerified: decoded.email_verified ?? false };
    } catch {
      return null;
    }
  }
  if (req.headers.has("authorization")) return null;
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
  // Observability only — a safety-log write failure must never fail (or
  // misleadingly 500) the user's chat/scan request.
  try {
    await d.collection("ai_safety_events").add({
      user_id: userId,
      event_type: eventType,
      detail: detail.slice(0, 500),
      created_at: nowTs(),
    });
  } catch (error) {
    logGatewayFailure("safety_log", { eventType }, error);
  }
}

// ---------------------------------------------------------------------------
// RAG context + memory + reporting grounding
// ---------------------------------------------------------------------------
async function buildRagContext(d: Db, message: string, country: string | null): Promise<string> {
  // Retrieval context is an enhancement, never a hard dependency: a Firestore
  // hiccup here used to escape as an unhandled exception and 500 the whole
  // chat request with a misleading "could not connect to the AI service".
  try {
    return await buildRagContextInner(d, message, country);
  } catch (error) {
    logGatewayFailure("rag_context", {}, error);
    return "";
  }
}

async function buildRagContextInner(d: Db, message: string, country: string | null): Promise<string> {
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
  try {
    const snap = await d.collection("user_memories").where("user_id", "==", userId).limit(5).get();
    if (snap.empty) return "";
    return snap.docs.map((m) => `- ${m.data().memory}`).join("\n");
  } catch (error) {
    logGatewayFailure("safe_memories", {}, error);
    return "";
  }
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
  usage?: AIProviderResponse["usage"];
  usageStatus?: "ok" | "partial";
  tier?: "high" | "low";
  steps?: WorkingStep[];
  taskContext?: PendingAgentTask | null;
}) {
  const {
    provider, providerName, user, conversationId, isTemporary, message, redactedMessage, reply,
    history, redaction, started, model, mode, codingDetected, files = [], projectId = null, requestId, usage, usageStatus,
    tier, steps, taskContext,
  } = opts;
  const convRef = d.collection("conversations").doc(conversationId);

  // Firestore has a 1 MiB document limit. If files are large, keep a compact version in message metadata
  // since the complete files are already safely stored in the project files collection.
  const safeArtifacts = mode === "agent" ? [] : files.map((file) => ({
    path: file.path,
    language: file.language,
    content: file.content.length > 60_000 ? file.content.slice(0, 60_000) : file.content,
  }));

  try {
    await convRef.collection("messages").add({
      role: "assistant",
      content: reply,
      metadata: {
        mode,
        model,
        ...(providerName ? { provider: providerName } : {}),
        coding_detected: codingDetected,
        duration_ms: Math.max(1, Date.now() - started),
        ...(tier ? { tier } : {}),
        ...(steps?.length ? { steps: steps.slice(0, 12) } : {}),
        ...(safeArtifacts.length ? { artifacts: safeArtifacts } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(taskContext ? { agent_task: { ...taskContext, state: taskContext.state === "CONVERSATION" ? "CONVERSATION" : classifyAgentOutput(reply).state }, execution_state: taskContext.state === "CONVERSATION" ? "CONVERSATION" : classifyAgentOutput(reply).state } : {}),
      },
      created_at: nowTs(),
    });
    await convRef.set({ updated_at: nowTs(), mode }, { merge: true });
  } catch (err) {
    logGatewayFailure("persist_assistant_message", { requestId, conversationId }, err);
  }

  // Rolling summary for permanent chats (spec §21) — best-effort.
  if (!isTemporary) {
    let count = 0;
    try {
      count = await countUserMessages(d, conversationId);
    } catch (error) {
      logGatewayFailure("count_user_messages", { requestId, conversationId }, error);
    }
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
    let count = 0;
    try {
      count = await countUserMessages(d, conversationId);
    } catch (error) {
      logGatewayFailure("count_user_messages", { requestId, conversationId }, error);
    }
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

  await logUsage(d, user.uid, model, "chat", usage ?? {}, Date.now() - started, usageStatus ?? "ok", requestId);
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
  const mode: ChatMode = requestChatMode(body.mode, isTemporary);
  const lane = isModelLane(body.lane) ? body.lane : "auto";
  const strategy = isStrategy(body.strategy) ? body.strategy : "balanced";
  const studyLevel = (["beginner", "school", "college", "university", "professional"] as StudyLevel[]).includes(body.study_level as StudyLevel) ? body.study_level as StudyLevel : "college";
  const explainStyle = (["simple", "detailed", "exam", "intuitive", "technical"] as ExplainStyle[]).includes(body.explain_style as ExplainStyle) ? body.explain_style as ExplainStyle : "simple";
  const attachments = normaliseTextAttachments(body.attachments);
  const requestedStream = body.stream === true;
  let wantStream = requestedStream;
  const regenerate = body.regenerate === true;
  const reuseUser = body.reuse_user === true || regenerate;
  let conversationPersistDegraded = false;
  const preferredLanguage: "en" | "bn" | undefined = body.language === "bn" ? "bn" : body.language === "en" ? "en" : undefined;

  if (mode !== "agent" && isThemeIntent(message)) {
    const reply = preferredLanguage === "bn" || /[\u0980-\u09ff]/.test(message) ? THEME_GALLERY_REPLY_BN : THEME_GALLERY_REPLY_EN;
    let convId = conversationId;
    try {
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
      if (!reuseUser) {
        await d.collection("conversations").doc(convId).collection("messages").add({
          role: "user", content: message, metadata: { mode: "general" }, created_at: nowTs(),
        });
      }
      await d.collection("conversations").doc(convId).collection("messages").add({
        role: "assistant", content: reply, metadata: { action: "theme_gallery" }, created_at: nowTs(),
      });
    } catch (error) {
      // The theme gallery is a static reply — never fail it over storage.
      logGatewayFailure("theme_gallery_persist", { requestId }, error);
    }
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
    let conv;
    try {
      conv = await d.collection("conversations").doc(convId).get();
    } catch (error) {
      logGatewayFailure("conversation_lookup", { requestId, userId: user.uid }, error);
      return json({ error: "CHAT_STORAGE_UNAVAILABLE", conversation_id: convId }, 503, requestId);
    }
    if (!conv.exists || conv.data()!.user_id !== user.uid) return json({ error: "CONVERSATION_NOT_FOUND" }, 404);
    // Mode is explicit per request. A stored Agent conversation cannot grant
    // execution authority to an omitted/General request.
    wantStream = requestedStream;
  } else {
    const title = message.replace(/\s+/g, " ").slice(0, 60);
    try {
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
    } catch (error) {
      logGatewayFailure("conversation_create", { requestId, userId: user.uid }, error);
      return json({ error: "CHAT_STORAGE_UNAVAILABLE" }, 503, requestId);
    }
  }
  const convRef = d.collection("conversations").doc(convId);
  const audioAssetId = typeof body.audio_asset_id === "string" ? body.audio_asset_id.trim() : "";
  let voiceMetadata: { audio_asset_id: string; audio_duration_ms: number; audio_waveform: number[]; audio_language: string | null } | null = null;
  if (audioAssetId) {
    if (!/^[a-f0-9-]{36}$/i.test(audioAssetId)) return json({ error: "AUDIO_NOT_FOUND" }, 404, requestId);
    const audioAsset = await d.collection("chat_audio_assets").doc(audioAssetId).get().catch(() => null);
    if (!audioAsset || !audioAsset.exists || audioAsset.data()?.user_id !== user.uid) return json({ error: "AUDIO_NOT_FOUND" }, 404, requestId);
    const saved = audioAsset.data()!;
    if (saved.transcription_status !== "complete" || !saved.transcript || saved.transcript.trim() !== message) return json({ error: "AUDIO_TRANSCRIPT_MISMATCH" }, 409, requestId);
    voiceMetadata = { audio_asset_id: audioAssetId, audio_duration_ms: Number(saved.duration_ms ?? 0), audio_waveform: Array.isArray(saved.waveform) ? saved.waveform.slice(0, 64) : [], audio_language: saved.detected_language ?? null };
  }
  // GPT OSS 120B is a text model and MATRIX routes to no other model, so an
  // attached image cannot be read. Say so before anything is stored, rather
  // than sending pixels to a model that would ignore or reject them.
  if (typeof body.image_storage_path === "string" && body.image_storage_path.trim()) {
    return json({ error: "VISION_NOT_SUPPORTED", detail: `${MATRIX_MODEL_LABEL} cannot read images. Remove the image and describe it in text, or paste the text it contains.` }, 422, requestId);
  }
  const chatImageDataUrl: string | undefined = undefined;
  let activeProjectId: string | null = null;
  const requestedProjectId = typeof body.project_id === "string" && body.project_id.trim() ? body.project_id.trim().slice(0, 128) : null;
  if (requestedProjectId) {
    const project = await d.collection("projects").doc(requestedProjectId).get();
    if (!project.exists || project.data()?.owner_id !== user.uid || project.data()?.archived_at) return json({ error: "PROJECT_NOT_FOUND", conversation_id: convId }, 404, requestId);
    activeProjectId = requestedProjectId;
    await convRef.set({ active_project_id: activeProjectId, updated_at: nowTs() }, { merge: true });
  } else {
    const storedProject = (await convRef.get()).data()?.active_project_id;
    activeProjectId = typeof storedProject === "string" ? storedProject : null;
  }

  // --- store original privately; only redacted text reaches AI providers ------
  const redaction = redactPII(message);
  if (!reuseUser) {
    try {
      const messageData = {
        role: "user", content: message,
        metadata: {
          pii_redacted: !redaction.safe, detected: redaction.detected.map((x) => x.type),
          mode, attachment_names: attachments.map((file) => file.name),
          ...(voiceMetadata ?? {}),
        },
        created_at: nowTs(),
      };
      if (audioAssetId) {
        const ref = convRef.collection("messages").doc();
        const assetRef = d.collection("chat_audio_assets").doc(audioAssetId);
        await d.runTransaction(async (tx) => {
          const snap = await tx.get(assetRef);
          if (snap.data()?.user_id !== user.uid || snap.data()?.conversation_id || snap.data()?.transcript !== message) throw new Error("AUDIO_ALREADY_SENT");
          tx.create(ref, messageData);
          tx.update(assetRef, { conversation_id: convId, message_id: ref.id });
        });
      } else await convRef.collection("messages").add(messageData);
    } catch (error) {
      if (audioAssetId) return json({ error: "AUDIO_MESSAGE_NOT_SAVED", conversation_id: convId }, 409, requestId);
      // The user's message reached the gateway; a storage hiccup must not
      // stop the assistant from answering. Flag the degradation in the reply.
      logGatewayFailure("persist_user_message", { requestId, conversationId: convId }, error);
      conversationPersistDegraded = true;
    }
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
  // decideRoute classifies the request (coding / agent / plain chat) to pick
  // prompts, tools and limits. Every class runs on the same model.
  const route = decideRoute({ mode, message, attachments, lane, strategy });
  const taskRaw = body.task_context as Record<string, unknown> | undefined;
  const taskContext: PendingAgentTask | null = mode === "agent" && taskRaw && typeof taskRaw.originalRequest === "string" && taskRaw.originalRequest.length <= 12_000
    ? { originalRequest: taskRaw.originalRequest, state: taskRaw.state === "CONVERSATION" ? "CONVERSATION" : "CLARIFICATION_REQUIRED",
        projectId: activeProjectId, clarifications: Array.isArray(taskRaw.clarifications)
          ? taskRaw.clarifications.slice(0, 10).filter((item: unknown) => item && typeof item === "object" && typeof (item as { question?: unknown }).question === "string" && typeof (item as { answer?: unknown }).answer === "string")
            .map((item: { question: string; answer: string }) => ({ question: item.question.slice(0, 1000), answer: item.answer.slice(0, 2000) })) : [] }
    : null;
  // Clarification is a Chat turn even if the original request contains
  // "build". The executable-Agent guard must not reject it after the UI
  // correctly selected Chat. Follow-ups require a persisted pending task in
  // this owner-verified conversation; a forged task_context cannot bypass it.
  const clarificationFirst = taskContext?.state === "CLARIFICATION_REQUIRED" &&
    taskContext.originalRequest === message && requestsClarificationFirst(message);
  let clarificationFollowup = false;
  if (taskContext?.state === "CLARIFICATION_REQUIRED" && !clarificationFirst) {
    const recent = (await convRef.collection("messages").get()).docs.sort(descDoc("created_at"));
    const latestTask = recent.find((doc) => doc.data().role === "assistant" && doc.data().metadata?.agent_task)?.data().metadata?.agent_task as PendingAgentTask | undefined;
    clarificationFollowup = latestTask?.state === "CLARIFICATION_REQUIRED" && latestTask.originalRequest === taskContext.originalRequest;
  }
  const agentExecutionRequired = mode === "agent" && (shouldRunBuildPipeline(detectBuildIntent(message, { agentMode: true, hasAttachments: attachments.length > 0 })) || isCodingRequest(message, attachments));
  if (agentExecutionRequired && !clarificationFirst && !clarificationFollowup) {
    return json({ error: "AGENT_RUNTIME_REQUIRED", detail: "Executable Agent work must use /api/build so files, task state, validation and deployment are persisted together.", conversation_id: convId, project_id: activeProjectId }, 409, requestId);
  }
  const codingDetected = route.coding || mode === "agent" || isCodingRequest(message, attachments);
  const useAgentPolicy = mode === "agent" || mode === "code";
  // The user's model pool (coordinator first). A per-request selection in the
  // body is honoured only for models that are really available; provider or
  // raw model fields are ignored.
  const pool = await resolvePool(d, user.uid, body.models && typeof body.models === "object" ? body.models as { auto?: boolean; enabled?: unknown } : null);
  const poolTargets = pool.targets;
  const targets = poolTargets.slice(0, 1);
  const selectedModel = targets[0]?.model ?? MATRIX_MODEL_ID;
  if (!targets.length) {
    await logUsage(d, user.uid, "none", "chat", {}, Date.now() - started, "error", requestId);
    return json({ error: useAgentPolicy ? "CODING_MODEL_NOT_CONFIGURED" : "AI_GATEWAY_NOT_CONFIGURED", conversation_id: convId }, 503, requestId);
  }

  // Context: summary + recent messages + safe memory + RAG.
  // Every read is best-effort: the assistant answers with less context rather
  // than the whole request failing.
  let summaryText = "";
  let recentDocs: { id: string; data: () => Record<string, unknown> }[] = [];
  let profileCountry: string | null = null;
  try {
    const [summaryDoc, recentSnap, profileDoc] = await Promise.all([
      d.collection("conversation_summaries").doc(convId).get(),
      convRef.collection("messages").get(),
      d.collection("profiles").doc(user.uid).get(),
    ]);
    summaryText = String(summaryDoc.data()?.summary ?? "");
    recentDocs = recentSnap.docs.sort(descDoc("created_at")).slice(0, 10).reverse();
    profileCountry = (profileDoc.data()?.country as string | undefined) ?? null;
  } catch (error) {
    logGatewayFailure("chat_context", { requestId, conversationId: convId }, error);
  }
  const history: AIMessage[] = [];
  if (summaryText) history.push({ role: "system", content: "Summary of the earlier conversation:\n" + summaryText });
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
  const memories = mode === "health" || mode === "code" ? "" : await loadSafeMemories(d, user.uid);
  if (memories) history.push({ role: "system", content: "Safe context about the user (never repeat back verbatim):\n" + memories });

  const rag = mode === "agent" ? "" : await buildRagContext(d, redaction.redacted, profileCountry);
  const safeAttachments = attachments.map((file) => {
    const result = redactPII(file.content);
    return { ...file, content: result.redacted };
  });
  const attachmentContext = formatAttachmentContext(safeAttachments);

  const messages: AIMessage[] = [
    ...buildModeSystemMessages(mode, rag, preferredLanguage, { studyLevel, explainStyle }),
    ...(taskContext?.state === "CLARIFICATION_REQUIRED" && requestsClarificationFirst(taskContext.originalRequest) && !taskContext.clarifications.length
      ? [{ role: "system" as const, content: "The user explicitly requested a clarification before any implementation. Ask exactly one essential missing requirement as a natural question. Do not produce files, claim a build, or publish yet." }]
      : []),
    ...history,
    ...(attachmentContext ? [{ role: "system" as const, content: attachmentContext }] : []),
    ...(codingDetected && mode === "general" ? [{
      role: "system" as const,
      content: "A coding task was automatically detected and is being handled by MATRIX coding routing. Give accurate, complete code and filenames, but do not emit MATRIX_FILE artifact blocks: live preview and GitHub push are available only in Agent mode.",
    }] : []),
    { role: "user", content: redaction.redacted },
  ];

  // --- Provider streaming path (Chat and Agent) --------------------------------
  if (wantStream && mode !== "agent" && targets[0]?.client.streamChat) {
    let done = false;
    let full = "";
    let activeTarget: AIRouteTarget = targets[0];
    let streamUsage: AIProviderResponse["usage"] | undefined;
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
        const recordedSteps: WorkingStep[] = [];
        const upsertStep = (next: WorkingStep) => {
          const idx = recordedSteps.findIndex((s) => s.id === next.id);
          if (idx >= 0) recordedSteps[idx] = next;
          else recordedSteps.push(next);
          emit({ step: next, tier: route.tier });
        };
        let reasoningStartAt: number | null = null;
        let genStartAt: number | null = null;
        let firstTokenAt: number | null = null;
        try {
          emit({
            conversation_id: convId,
            mode,
            model: activeTarget.model,
            provider: activeTarget.provider,
            tier: route.tier,
            coding_detected: codingDetected,
            stream_status: "connecting",
          });
          const collaborationPlan = chatImageDataUrl
            ? planCollaboration({ message, pool: poolTargets.slice(0, 1) })
            : planCollaboration({ message, pool: poolTargets, kind: codingDetected ? "code" : undefined });
          upsertStep({
            id: "route",
            label: collaborationPlan.mode === "single" ? `Using ${modelLabel(activeTarget.model)}` : `${poolTargets.length} models working together`,
            detail: collaborationPlan.mode === "single" ? collaborationPlan.reason : poolTargets.map((target) => modelLabel(target.model)).join(" · "),
            status: "done",
            at: Date.now(),
            durationMs: Math.max(1, Date.now() - started),
          });
          for (const skipped of pool.skipped) {
            upsertStep({ id: `skipped-${skipped.key}`, label: `${skipped.label} is not available`, detail: skipped.reason, status: "failed", at: Date.now() });
          }
          // --- Collaboration: each model does its own part, then the
          // coordinator writes the one answer the user sees.
          let finalMessages = messages;
          let separateText: string | null = null;
          if (collaborationPlan.mode !== "single") {
            const collaboration = await runCollaboration({
              plan: collaborationPlan,
              pool: poolTargets,
              messages,
              requestId,
              deadlineAt: Date.now() + 75_000,
              onEvent: (event) => {
                if (event.type === "task_start") {
                  upsertStep({ id: `task-${event.task.id}`, label: `${event.task.role}: ${event.task.responsibility}`, detail: event.label, status: "running", at: Date.now() });
                } else if (event.type === "task_done") {
                  const { result } = event;
                  const replaced = result.attempts.filter((attempt) => attempt.outcome !== "ok").map((attempt) => `${attempt.label} ${attempt.outcome === "skipped" ? "skipped" : "failed"} (${attempt.detail})`);
                  upsertStep({
                    id: `task-${result.task.id}`,
                    label: `${result.task.role}: ${result.task.responsibility}`,
                    detail: result.status === "done" ? [result.label, ...replaced].join(" · ") : replaced.join(" · ") || "No model could take this part",
                    status: result.status === "done" ? "done" : "failed",
                    at: Date.now() - result.durationMs,
                    durationMs: Math.max(1, result.durationMs),
                  });
                } else {
                  upsertStep({ id: "compare", label: event.agreement === "low" ? "Compared outputs — resolving differences" : "Compared outputs", detail: event.detail, status: "done", at: Date.now() });
                }
              },
            });
            for (const [model, usage] of Object.entries(collaboration.usageByModel)) {
              void logUsage(d, user.uid, model, "chat_collaboration", usage, Date.now() - started, "ok", requestId);
            }
            if (collaborationPlan.mode === "separate") separateText = separateAnswers(collaboration.results);
            else if (collaboration.brief) finalMessages = [...messages.slice(0, -1), collaboration.brief, messages[messages.length - 1]];
          }
          const answerStream = (request: Parameters<typeof streamWithModel>[1]) => {
            if (separateText !== null) {
              const text = separateText;
              return (async function* () {
                for (const part of text.split(/(?<=\n)/)) yield { delta: part, target: activeTarget };
              })();
            }
            return streamWithFallback(poolTargets, { ...request, messages: finalMessages }, {
              onStart: (target) => { activeTarget = target; },
              onFallback: (from, to, error) => {
                logProviderFailure(error, requestId);
                upsertStep({ id: `fallback-${modelLabel(from.model)}`, label: `${modelLabel(from.model)} did not respond`, detail: `Continuing with ${modelLabel(to.model)}`, status: "failed", at: Date.now() });
              },
            });
          };
          if (rag || safeAttachments.length || chatImageDataUrl) {
            upsertStep({
              id: "context",
              label: chatImageDataUrl
                ? "Prepared vision attachment"
                : safeAttachments.length
                  ? `Processed ${safeAttachments.length} attachment${safeAttachments.length === 1 ? "" : "s"}`
                  : "Retrieved verified knowledge",
              status: "done",
              at: Date.now(),
            });
          }
          emit({ stream_status: "streaming" });
          genStartAt = Date.now();
          upsertStep({
            id: "generate",
            label: codingDetected ? "Generating code & solution" : "Writing the answer",
            status: "running",
            at: genStartAt,
          });
          for await (const item of answerStream(
            {
              messages,
              ...(chatImageDataUrl ? { imageDataUrl: chatImageDataUrl } : {}),
              temperature: codingDetected ? 0.3 : 0.5,
              maxTokens: codingDetected ? 4096 : 1600,
              requestId,
              onUsage: (usage) => { streamUsage = usage; },
              onReasoningActivity: (phase) => {
                if (phase === "start" && reasoningStartAt === null) {
                  reasoningStartAt = Date.now();
                  upsertStep({
                    id: "reasoning",
                    label: "Deep reasoning",
                    detail: `${activeTarget.provider} · ${activeTarget.model}`,
                    status: "running",
                    at: reasoningStartAt,
                  });
                } else if (phase === "done" && reasoningStartAt !== null) {
                  const dur = Math.max(1, Date.now() - reasoningStartAt);
                  upsertStep({
                    id: "reasoning",
                    label: "Deep reasoning",
                    detail: `${activeTarget.provider} · ${activeTarget.model}`,
                    status: "done",
                    at: reasoningStartAt,
                    durationMs: dur,
                  });
                }
              },
            },
          )) {
            const delta = item.delta;
            if (firstTokenAt === null) firstTokenAt = Date.now();
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
          if (reasoningStartAt !== null) {
            const rStep = recordedSteps.find((s) => s.id === "reasoning");
            if (rStep && rStep.status === "running") {
              upsertStep({ ...rStep, status: "done", durationMs: Math.max(1, Date.now() - reasoningStartAt) });
            }
          }
          upsertStep({
            id: "generate",
            label: codingDetected ? "Generated code & solution" : "Synthesized response",
            status: "done",
            at: genStartAt ?? started,
            durationMs: Math.max(1, Date.now() - (genStartAt ?? started)),
          });
          emit({ stream_status: "finalizing" });
          const streamedReply = stripReasoningContent(full);
          const streamedFiles: AgentFile[] = [];
          const projectId = activeProjectId;
          const analytics = computeAnalytics({
            started,
            firstTokenAt: firstTokenAt ?? started,
            promptTokens: streamUsage?.promptTokens ?? 0,
            completionTokens: streamUsage?.completionTokens ?? 0,
            agentSteps: recordedSteps.length,
            toolsExecuted: 0,
          });
          let degraded = conversationPersistDegraded;
          try {
            await finalizeChat(d, {
              provider: activeTarget.client, providerName: activeTarget.provider, user, conversationId: convId, isTemporary, message,
              redactedMessage: redaction.redacted, reply: streamedReply, history, redaction, started,
              model: activeTarget.model, mode, codingDetected, files: streamedFiles, projectId, requestId, usage: streamUsage,
              tier: route.tier, steps: recordedSteps, taskContext,
            });
          } catch (error) {
            degraded = true;
            logGatewayFailure("finalize_chat_stream", { requestId, conversationId: convId }, error);
          }
          emit({
            done: true,
            conversation_id: convId,
            pii_redacted: !redaction.safe,
            mode,
            model: activeTarget.model,
            provider: activeTarget.provider,
            tier: route.tier,
            steps: recordedSteps,
            duration_ms: Math.max(1, Date.now() - started),
            coding_detected: codingDetected,
            files: streamedFiles,
            project_id: projectId,
            analytics,
            stream_status: "complete",
            ...(degraded ? { storage_degraded: true } : {}),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "stream error";
          if (msg !== "CLIENT_DISCONNECTED") {
            logProviderFailure(e, requestId);
            if (!full.trim()) await logUsage(d, user.uid, activeTarget.model, "chat", streamUsage ?? {}, Date.now() - started, "error", requestId);
          }
          // Persist whatever actually streamed so Stop / disconnect doesn't
          // throw the reply away — the client can keep it on screen too.
          if (full && !done) {
            try {
              await finalizeChat(d, {
                provider: activeTarget.client, providerName: activeTarget.provider, user, conversationId: convId, isTemporary, message,
                redactedMessage: redaction.redacted, reply: full, history, redaction, started,
                model: activeTarget.model, mode, codingDetected, requestId, usage: streamUsage, usageStatus: "partial", taskContext,
              });
              done = true;
            } catch {
              if (msg !== "CLIENT_DISCONNECTED") await logUsage(d, user.uid, activeTarget.model, "chat", streamUsage ?? {}, Date.now() - started, "partial", requestId);
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

  // --- Non-streaming conversation path (never writes project files) ----------
  let rawReply: string;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let toolsExecuted = 0;
  let toolCallsProcessed = 0;
  let toolRounds = 0;
  let activeTarget: AIRouteTarget = targets[0];
  const nonStreamSteps: WorkingStep[] = [];
  let sawReasoning = false;
  try {
    const safeTools = mode === "agent" && targets[0].client.supportsToolCalls ? modelCallableTools() : [];
    const agentMessages = [...messages];
    const callStarted = Date.now();
    const firstRequest = {
      messages: agentMessages,
      ...(chatImageDataUrl ? { imageDataUrl: chatImageDataUrl } : {}),
      ...(safeTools.length ? { tools: safeTools } : {}),
      temperature: mode === "agent" ? 0.25 : 0.5,
      maxTokens: mode === "agent" ? 16384 : codingDetected ? 4096 : 1600,
      requestId,
      onReasoningActivity: () => { sawReasoning = true; },
    };
    let result: Awaited<ReturnType<typeof completeWithModel>>;
    let fallbackNote = "";
    try {
      result = await completeWithModel(targets, firstRequest);
    } catch (error) {
      // The lead model could not answer: continue with the next suitable
      // model in the user's pool. If none can, report the real error.
      const others = poolTargets.slice(1).filter((target) => !safeTools.length || target.client.supportsToolCalls);
      const { completed } = others.length ? await completeWithFallback(others, () => firstRequest) : { completed: null };
      if (!completed) throw error;
      logProviderFailure(error, requestId);
      fallbackNote = `${modelLabel(targets[0].model)} did not respond`;
      result = completed;
    }
    activeTarget = result.target;
    nonStreamSteps.push({
      id: "route",
      label: `Using ${modelLabel(activeTarget.model)}`,
      detail: fallbackNote || undefined,
      status: "done",
      at: started,
      durationMs: Math.max(1, callStarted - started),
    });
    if (sawReasoning) {
      nonStreamSteps.push({
        id: "reasoning",
        label: "Deep reasoning",
        detail: `${activeTarget.provider} · ${activeTarget.model}`,
        status: "done",
        at: callStarted,
      });
    }
    usage = { ...result.response.usage };

    // Model-directed execution is limited to explicitly reviewed read-only
    // tools. Every invocation still passes through the authenticated gateway,
    // which validates args, scopes, permissions, rate limits, and audits it.
    // Side-effecting tools remain manual/approval-gated and are not advertised.
    while (safeTools.length && result.response.toolCalls?.length && toolRounds < 4) {
      toolRounds += 1;
      const calls = result.response.toolCalls;
      agentMessages.push({ role: "assistant", content: result.response.content ?? "", tool_calls: calls });
      for (const call of calls) {
        const name = typeof call.function?.name === "string" ? call.function.name : "";
        const toolStart = Date.now();
        let toolResult: { ok: boolean; data?: Record<string, unknown>; message?: string; error?: string; request_id?: string };
        await recordAgentToolSelection(d, user.uid, name.slice(0, 64), "Provider model requested an Agent tool.");
        toolCallsProcessed += 1;
        if (toolCallsProcessed > 3) {
          toolResult = { ok: false, error: "AGENT_TOOL_CALL_LIMIT" };
        } else {
          try {
            const parsed = JSON.parse(call.function.arguments || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object.");
            toolResult = await executeAgentTool(d, user, name, parsed, { modelInitiated: true });
            toolsExecuted += 1;
          } catch (error) {
            toolResult = { ok: false, error: error instanceof Error ? error.message.slice(0, 160) : "INVALID_TOOL_ARGUMENTS" };
          }
        }
        nonStreamSteps.push({
          id: `tool:${toolRounds}:${name}`,
          label: `Executed tool · ${name || "tool"}`,
          status: toolResult.ok ? "done" : "failed",
          at: toolStart,
          durationMs: Math.max(1, Date.now() - toolStart),
        });
        const toolCallId = typeof call.id === "string" ? call.id.slice(0, 128) : "invalid_tool_call";
        agentMessages.push({ role: "tool", tool_call_id: toolCallId, name: name.slice(0, 64), content: JSON.stringify(toolResult).slice(0, 6000) });
      }
      result = await completeWithModel([result.target], {
        messages: agentMessages,
        ...(toolCallsProcessed < 3 ? { tools: safeTools } : {}),
        temperature: 0.25,
        maxTokens: 4096,
        requestId,
      });
      activeTarget = result.target;
      usage = {
        promptTokens: usage.promptTokens + result.response.usage.promptTokens,
        completionTokens: usage.completionTokens + result.response.usage.completionTokens,
        totalTokens: usage.totalTokens + result.response.usage.totalTokens,
      };
    }
    rawReply = result.response.content;
    if (!rawReply.trim()) throw new Error("AGENT_TOOL_LOOP_RETURNED_NO_FINAL_ANSWER");
    nonStreamSteps.push({
      id: "generate",
      label: codingDetected ? "Generated code & solution" : "Synthesized response",
      status: "done",
      at: Date.now(),
      durationMs: Math.max(1, Date.now() - callStarted),
    });
  } catch (error) {
    logProviderFailure(error, requestId);
    await logUsage(d, user.uid, activeTarget?.model ?? selectedModel, "chat", {}, Date.now() - started, "error", requestId);
    return json({ error: providerPublicCode(error), conversation_id: convId, ...providerDiagnostic(error, targets.length) }, providerStatus(error), requestId);
  }

  // Never persist or render the model's chain-of-thought. Providers already
  // drop reasoning, but scrub once more here as a safety net (some mirrors
  // return thinking inside `content`).
  rawReply = stripReasoningContent(rawReply);
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

  const reply = rawReply.trim();
  const files: AgentFile[] = [];
  const projectId = activeProjectId;

  let finalizeFailed = conversationPersistDegraded;
  try {
    await finalizeChat(d, {
      provider: activeTarget.client, providerName: activeTarget.provider, user, conversationId: convId, isTemporary, message,
      redactedMessage: redaction.redacted, reply, history, redaction, started,
      model: activeTarget.model, mode, codingDetected, files, projectId, requestId, usage,
      tier: route.tier, steps: nonStreamSteps, taskContext,
    });
  } catch (error) {
    // The AI answered — never convert that into a request failure. Surface the
    // degraded persistence honestly instead.
    finalizeFailed = true;
    logGatewayFailure("finalize_chat", { requestId, conversationId: convId }, error);
  }
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
    tier: route.tier,
    steps: nonStreamSteps,
    duration_ms: Math.max(1, Date.now() - started),
    coding_detected: codingDetected,
    usage,
    analytics: computeAnalytics({
      started,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      agentSteps: 1,
      toolsExecuted,
    }),
    ...(finalizeFailed ? { storage_degraded: true } : {}),
    request_id: requestId,
  }, 200, requestId);
}

async function handleImage(d: Db, user: SessionUser, body: Record<string, unknown>) {
  const started = Date.now();
  const requestId = requestIdFrom(body);
  const prompt = typeof body.message === "string" ? body.message.trim() : (typeof body.prompt === "string" ? body.prompt.trim() : "");
  if (!prompt) return json({ error: "MESSAGE_REQUIRED" }, 400, requestId);
  if (prompt.length > 4000) return json({ error: "MESSAGE_TOO_LONG" }, 400, requestId);
  if (!(await isImageGenerationConfigured(d))) return json({ error: "IMAGE_NOT_CONFIGURED" }, 503, requestId);

  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
  const isTemporary = body.is_temporary === true;
  let convId = conversationId;
  try {
    if (!convId) {
      const created = await d.collection("conversations").add({
        user_id: user.uid,
        title: prompt.replace(/\s+/g, " ").slice(0, 60),
        mode: "image",
        is_temporary: isTemporary,
        summary: "",
        archived_at: null,
        deleted_at: null,
        created_at: nowTs(),
        updated_at: nowTs(),
      });
      convId = created.id;
    }
    await d.collection("conversations").doc(convId).collection("messages").add({
      role: "user",
      content: prompt,
      metadata: { mode: "image" },
      created_at: nowTs(),
    });
  } catch (error) {
    logGatewayFailure("image_persist_user", { requestId }, error);
  }

  try {
    const image = await generateImage(d, prompt);
    const dataUrl = `data:${image.mime};base64,${image.b64}`;
    const reply = "Image ready.";
    const imageSteps: WorkingStep[] = [
      {
        id: "prompt",
        label: "Prompt prepared",
        status: "done",
        detail: image.provider,
        at: started,
      },
      {
        id: "render",
        label: "Image rendered",
        status: "done",
        detail: image.model,
        durationMs: Math.max(1, Date.now() - started),
        at: Date.now(),
      },
    ];
    if (convId) {
      try {
        await d.collection("conversations").doc(convId).collection("messages").add({
          role: "assistant",
          content: reply,
          metadata: { mode: "image", image_data_url: dataUrl, model: image.model, provider: image.provider, steps: imageSteps },
          created_at: nowTs(),
        });
      } catch (error) {
        logGatewayFailure("image_persist_assistant", { requestId }, error);
      }
    }
    await logUsage(d, user.uid, image.model, "image", {}, Date.now() - started, "ok", requestId);
    return json({
      reply,
      conversation_id: convId,
      mode: "image",
      image: { mime: image.mime, data_url: dataUrl },
      image_url: dataUrl,
      model: image.model,
      provider: image.provider,
      steps: imageSteps,
      image_status: "ready",
      analytics: computeAnalytics({ started, completionTokens: 0, toolsExecuted: 1, agentSteps: 4 }),
      request_id: requestId,
    }, 200, requestId);
  } catch (error) {
    const code = imageErrorCode(error);
    console.error("[MATRIX] image generation failed", code, error);
    await logUsage(d, user.uid, "image", "image", {}, Date.now() - started, "error", requestId);
    return json({ error: code, conversation_id: convId, image_status: "failed" }, code === "IMAGE_NOT_CONFIGURED" ? 503 : 502, requestId);
  }
}

async function handleOrchestrate(d: Db, user: SessionUser, body: Record<string, unknown>) {
  const started = Date.now();
  const requestId = requestIdFrom(body);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "MESSAGE_REQUIRED" }, 400, requestId);
  const tasks = planOrchestrator(message);
  const sections: Array<{ id: string; title: string; mode: string; reply?: string; error?: string; image_data_url?: string }> = [];
  for (const task of tasks) {
    if (task.mode === "image") {
      if (!(await isImageGenerationConfigured(d))) {
        sections.push({ id: task.id, title: task.title, mode: task.mode, error: "IMAGE_NOT_CONFIGURED" });
        continue;
      }
      try {
        const image = await generateImage(d, task.prompt);
        sections.push({ id: task.id, title: task.title, mode: task.mode, reply: "Image ready.", image_data_url: `data:${image.mime};base64,${image.b64}` });
      } catch (error) {
        sections.push({ id: task.id, title: task.title, mode: task.mode, error: imageErrorCode(error) });
      }
      continue;
    }
    const coding = task.mode === "code" || task.mode === "agent";
    const taskTier: "high" | "low" = coding || task.mode === "study" || task.mode === "research" ? "high" : "low";
    const targets = await createAIRoutesFromDb(d);
    if (!targets.length) {
      sections.push({ id: task.id, title: task.title, mode: task.mode, error: "AI_GATEWAY_NOT_CONFIGURED" });
      continue;
    }
    try {
      const completed = await completeWithModel(targets, {
        messages: [
          ...buildModeSystemMessages(task.mode, "", undefined),
          { role: "user", content: task.prompt },
        ],
        temperature: 0.4,
        maxTokens: 1800,
        requestId,
      });
      sections.push({ id: task.id, title: task.title, mode: task.mode, reply: stripReasoningContent(completed.response.content) });
    } catch (error) {
      sections.push({ id: task.id, title: task.title, mode: task.mode, error: providerPublicCode(error) });
    }
  }
  const reply = sections.map((s) => {
    if (s.error) return `## ${s.title}\n\n_${s.error}_`;
    return `## ${s.title}\n\n${s.reply ?? ""}`;
  }).join("\n\n");
  let convId = typeof body.conversation_id === "string" ? body.conversation_id : null;
  try {
    if (!convId) {
      const created = await d.collection("conversations").add({
        user_id: user.uid, title: message.slice(0, 60), mode: "orchestrator", is_temporary: false,
        summary: "", archived_at: null, deleted_at: null, created_at: nowTs(), updated_at: nowTs(),
      });
      convId = created.id;
    }
    await d.collection("conversations").doc(convId).collection("messages").add({ role: "user", content: message, metadata: { mode: "orchestrator" }, created_at: nowTs() });
    await d.collection("conversations").doc(convId).collection("messages").add({
      role: "assistant", content: reply, metadata: { mode: "orchestrator", orchestrator: sections.map((s) => ({ id: s.id, title: s.title, status: s.error ? "failed" : "completed", image_data_url: s.image_data_url })) }, created_at: nowTs(),
    });
  } catch (error) {
    logGatewayFailure("orchestrate_persist", { requestId }, error);
  }
  await logUsage(d, user.uid, "orchestrator", "chat", {}, Date.now() - started, "ok", requestId);
  return json({
    reply,
    conversation_id: convId,
    mode: "orchestrator",
    tasks: sections,
    analytics: computeAnalytics({ started, agentSteps: tasks.length, toolsExecuted: sections.filter((s) => !s.error).length }),
    request_id: requestId,
  }, 200, requestId);
}

// ---------------------------------------------------------------------------
// Scan action (screenshot analysis, spec §14)
// ---------------------------------------------------------------------------
async function handleScan(_d: Db, _user: SessionUser, body: Record<string, unknown>) {
  // Screenshot analysis needs a model that can read images. MATRIX runs only
  // GPT OSS 120B, a text model, and never routes to another model — so this
  // is reported honestly instead of being answered by a different model.
  void _d; void _user;
  return json({
    error: "VISION_NOT_SUPPORTED",
    detail: `${MATRIX_MODEL_LABEL} cannot read images. Paste the text from the screenshot into the chat or the scanner's text box instead.`,
  }, 422, requestIdFrom(body));
}

// ---------------------------------------------------------------------------
// Health (unauthenticated, honest): reports whether the gateway can actually
// reach the AI provider. Used by the UI status indicator and /api/health.
// ---------------------------------------------------------------------------
async function handleHealth(mode: ChatMode = "general") {
  // Firestore may be unavailable during initial setup; in that case only the
  // environment-keyed providers are available, so the health probe stays sane.
  let d: Db | null = null;
  try {
    d = adminDb();
  } catch {
    /* not configured yet */
  }
  const targets = await createAIRoutesFromDb(d);
  if (!targets.length) return json({ status: "unconfigured", mode }, 503);
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    if (await target.client.healthCheck(target.model)) {
      return json({
        status: "online",
        mode,
        provider: target.provider,
        chat_model: target.model,
      });
    }
  }
  return json({ status: "unavailable", mode, chat_model: targets[0].model }, 503);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
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
    if (action === "cancel_pending_task") {
      if (user.deviceId) return json({ error: "DEVICE_SCOPE_DENIED" }, 403);
      const id = typeof body.conversation_id === "string" ? body.conversation_id.slice(0, 128) : "";
      if (!id) return json({ error: "CONVERSATION_NOT_FOUND" }, 404);
      const ref = d.collection("conversations").doc(id);
      const conversation = await ref.get();
      if (!conversation.exists || conversation.data()?.user_id !== user.uid || conversation.data()?.deleted_at) return json({ error: "CONVERSATION_NOT_FOUND" }, 404);
      const original = typeof body.original_request === "string" ? body.original_request.slice(0, 12_000) : "";
      const pending = (await ref.collection("messages").get()).docs
        .sort(descDoc("created_at"))
        .find((doc) => doc.data().role === "assistant" && doc.data().metadata?.agent_task)?.data().metadata?.agent_task as PendingAgentTask | undefined;
      if (!pending || pending.state !== "CLARIFICATION_REQUIRED" || pending.originalRequest !== original) return json({ error: "NO_PENDING_TASK" }, 409);
      await ref.collection("messages").add({ role: "user", content: "Cancel the task", metadata: { mode: "agent" }, created_at: nowTs() });
      const reply = "Okay, I won't start the build. Your existing project is unchanged.";
      await ref.collection("messages").add({ role: "assistant", content: reply, metadata: { mode: "agent", execution_state: "CONVERSATION", agent_task: { ...pending, state: "CONVERSATION" } }, created_at: nowTs() });
      await ref.set({ updated_at: nowTs() }, { merge: true });
      // A provider-side clarification may have opened a durable Agent task;
      // explicit pre-build questions have none. Cancel only the bound task.
      if (pending.taskId) {
        try { await cancelAgentTask(d, user, pending.taskId); }
        catch (error) { logGatewayFailure("cancel_agent_task", { conversationId: id }, error); }
      }
      return json({ reply, conversation_id: id });
    }
    if (action === "chat") {
      const denied = deviceScopeResponse(user, "chat:write");
      if (denied) return denied;
      return await handleChat(d, user, body);
    }
    if (user.deviceId) return json({ error: "DEVICE_SCOPE_DENIED" }, 403);
    if (action === "scan") return await handleScan(d, user, body);
    if (action === "image") return await handleImage(d, user, body);
    if (action === "orchestrate") return await handleOrchestrate(d, user, body);
    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    if (e instanceof AIProviderError) logProviderFailure(e, requestId);
    else logGatewayFailure("route", { requestId }, e);
    return json({ error: "INTERNAL", request_id: requestId }, 500, requestId);
  }
}
