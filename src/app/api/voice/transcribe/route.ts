import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { isCloudinaryConfigured } from "@/lib/env";
import { GeminiProvider } from "@/lib/ai/gemini";
import { isOwnedChatAudioPath, matchesAudioContainer } from "@/lib/ai/audio";
import { AIProviderError, logProviderFailure, providerPublicCode, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { deletePrivateAudio, downloadPrivateAudio, uploadPrivateAudio } from "@/lib/server/cloudinary";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { cleanupStaleVoiceDrafts } from "@/lib/server/voice-cleanup";
import { normalizeDetectedLanguage, whisperLanguageHint } from "@/lib/voice-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/mpga", "audio/ogg", "audio/opus",
  "audio/wav", "audio/webm", "audio/3gpp", "audio/x-aac", "audio/x-wav",
]);

function providerStatus(error: unknown): number {
  if (error instanceof AIProviderError) {
    if (error.type === "authentication") return 503;
    if (error.type === "timeout") return 504;
    if (error.type === "invalid_request") return 400;
    if (error.type === "rate_limit" || error.type === "billing" || error.type === "provider_unavailable") return 503;
  }
  return 502;
}

function keyPresent(v: string | undefined): string {
  const s = v?.trim() ?? "";
  return s && !s.endsWith("...") && !s.startsWith("YOUR-") && !s.startsWith("replace-with") ? s : "";
}

async function transcribeViaOpenAICompatible(opts: {
  baseUrl: string;
  apiKey: string;
  providerLabel: "Groq" | "OpenAI";
  model: string;
  bytes: Buffer;
  filename: string;
  mimeType: string;
  /** ISO-639-1 hint; empty = let the model detect the language. */
  language?: string;
  signal?: AbortSignal;
}): Promise<{ transcript: string; model: string; provider: string; usage: Record<string, unknown> }> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(opts.bytes)], { type: opts.mimeType }), opts.filename);
  fd.append("model", opts.model);
  // Without a hint Whisper detects the spoken language (including
  // code-switching). A hint is sent only when the user chose a language.
  if (opts.language) fd.append("language", opts.language);
  fd.append("response_format", "verbose_json");
  const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: fd,
    signal: opts.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw providerErrorFromResponse(opts.providerLabel, opts.model, res, detail);
  }
  const data = (await res.json()) as { text?: string; language?: string };
  const transcript = typeof data.text === "string" ? data.text.trim() : "";
  if (!transcript) {
    throw new AIProviderError({ provider: opts.providerLabel, model: opts.model, type: "empty_response", detail: "Empty transcription result" });
  }
  return { transcript, model: opts.model, provider: opts.providerLabel, usage: { detected_language: normalizeDetectedLanguage(data.language) ?? (opts.language || null) } };
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const groqKey = keyPresent(process.env.GROQ_API_KEY);
  const openaiKey = keyPresent(process.env.OPENAI_API_KEY);
  const geminiKey = keyPresent(process.env.GEMINI_API_KEY);
  const geminiAudioModel = process.env.GEMINI_AUDIO_MODEL?.trim() ?? "";

  // A Gemini key alone is enough: without GEMINI_AUDIO_MODEL the audio model
  // is taken from the key's live catalogue at call time.
  const hasProvider = Boolean(groqKey || openaiKey || geminiKey);
  if (!hasProvider) return NextResponse.json({ error: "VOICE_TRANSCRIPTION_NOT_CONFIGURED" }, { status: 503 });

  const form = await req.formData().catch(() => null);
  const languageHint = whisperLanguageHint(typeof form?.get("language") === "string" ? String(form.get("language")) : "");
  // Dictation (composer voice input) only needs the words. The recording is
  // kept as a private, playable voice message when storage is configured and
  // the client asked for it; otherwise it is transcribed and discarded.
  // Previously a deployment without Cloudinary could not use voice at all.
  const wantsStorage = String(form?.get("store") ?? "1") !== "0";
  const storageReady = isCloudinaryConfigured();
  const persist = wantsStorage && storageReady;
  if (typeof form?.get("audio_asset_id") === "string" && !storageReady) return NextResponse.json({ error: "VOICE_STORAGE_NOT_CONFIGURED" }, { status: 503 });
  const d = adminDb();
  await cleanupStaleVoiceDrafts(d).catch(() => {});
  const retryId = typeof form?.get("audio_asset_id") === "string" ? String(form.get("audio_asset_id")) : "";
  const file = form?.get("audio");
  let id: string;
  let mimeType: string;
  let bytes: Buffer;
  let filename: string;
  let audioRef: ReturnType<ReturnType<ReturnType<typeof adminDb>["collection"]>["doc"]> | null = null;
  if (retryId) {
    if (!/^[a-f0-9-]{36}$/i.test(retryId)) return NextResponse.json({ error: "AUDIO_NOT_FOUND" }, { status: 404 });
    id = retryId;
    audioRef = d.collection("chat_audio_assets").doc(id);
    const record = (await audioRef.get()).data();
    if (record?.user_id !== user.uid || record?.conversation_id || !isOwnedChatAudioPath(user.uid, String(record.storage_public_id ?? ""))) {
      return NextResponse.json({ error: "AUDIO_NOT_FOUND" }, { status: 404 });
    }
    mimeType = String(record.mime_type ?? "").split(";")[0];
    const downloaded = await downloadPrivateAudio(record.storage_public_id, String(record.storage_format ?? ""));
    if (!downloaded || !ALLOWED_AUDIO_TYPES.has(mimeType) || downloaded.bytes.length > MAX_AUDIO_BYTES) return NextResponse.json({ error: "AUDIO_UNAVAILABLE" }, { status: 503 });
    bytes = downloaded.bytes;
    filename = `voice.${String(record.storage_format ?? "webm")}`;
  } else {
    if (!(file instanceof File)) return NextResponse.json({ error: "AUDIO_REQUIRED" }, { status: 400 });
    mimeType = file.type.toLowerCase().split(";")[0];
    if (!ALLOWED_AUDIO_TYPES.has(mimeType)) return NextResponse.json({ error: "AUDIO_TYPE_UNSUPPORTED" }, { status: 415 });
    if (!file.size || file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: "AUDIO_SIZE_INVALID", max_bytes: MAX_AUDIO_BYTES }, { status: 413 });
    bytes = Buffer.from(await file.arrayBuffer());
    filename = file.name || "voice.webm";
    id = randomUUID();
    if (persist) audioRef = d.collection("chat_audio_assets").doc(id);
  }
  if (!matchesAudioContainer(bytes, mimeType)) return NextResponse.json({ error: "AUDIO_CONTENT_INVALID" }, { status: 415 });
  if (!retryId && persist && audioRef) {
    let stored: Awaited<ReturnType<typeof uploadPrivateAudio>>;
    try {
      stored = await uploadPrivateAudio(user.uid, bytes, filename);
    } catch (error) {
      console.error("[MATRIX] private voice upload failed", { uid: user.uid, detail: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      return NextResponse.json({ error: "VOICE_UPLOAD_FAILED" }, { status: 502 });
    }
    try {
      const duration = Number(form?.get("duration_ms") ?? 0);
      const samples = String(form?.get("waveform") ?? "").split(",").slice(0, 64).map(Number);
      await audioRef.create({
        user_id: user.uid, storage_provider: "cloudinary", storage_public_id: stored.publicId,
        storage_version: stored.version, storage_format: stored.format, mime_type: mimeType,
        bytes: stored.bytes, duration_ms: Number.isFinite(duration) ? Math.max(0, Math.min(duration, 600_000)) : 0,
        waveform: samples.length >= 4 && samples.every((n) => Number.isInteger(n) && n >= 0 && n <= 100) ? samples : [],
        transcription_status: "processing", created_at: nowTs(),
      });
    } catch (error) {
      await deletePrivateAudio(stored.publicId);
      console.error("[MATRIX] voice metadata persistence failed", { uid: user.uid, detail: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      return NextResponse.json({ error: "VOICE_STORAGE_FAILED" }, { status: 503 });
    }
  }

  const startedAt = Date.now();
  let usedModel = "whisper-large-v3-turbo";

  try {
    // Every configured speech provider is tried in order. One provider being
    // rate-limited or rejecting a container must not fail voice input while
    // another configured provider can transcribe the same audio.
    type Transcription = { transcript: string; model: string; provider: string; usage: Record<string, unknown> };
    const attempts: Array<{ model: string; run: () => Promise<Transcription> }> = [];
    if (groqKey) {
      const model = process.env.GROQ_AUDIO_MODEL?.trim() || "whisper-large-v3-turbo";
      attempts.push({ model, run: () => transcribeViaOpenAICompatible({ baseUrl: "https://api.groq.com/openai/v1", apiKey: groqKey, providerLabel: "Groq", model, bytes, filename, mimeType, language: languageHint, signal: req.signal }) });
    }
    if (openaiKey) {
      const model = process.env.OPENAI_AUDIO_MODEL?.trim() || "whisper-1";
      attempts.push({ model, run: () => transcribeViaOpenAICompatible({ baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1", apiKey: openaiKey, providerLabel: "OpenAI", model, bytes, filename, mimeType, language: languageHint, signal: req.signal }) });
    }
    if (geminiKey) {
      attempts.push({ model: geminiAudioModel || "gemini (catalogue)", run: async () => {
        const provider = new GeminiProvider(geminiKey);
        let model = geminiAudioModel;
        if (!model) {
          // Audio understanding is a Flash-family capability; take the newest
          // listed stable Flash model rather than assuming an identifier.
          const listed = (await provider.listModels()).map((entry) => entry.id)
            .filter((id) => /^gemini-[\d.]+-flash(?:-lite)?(?:-\d+)?$/.test(id) || /^gemini-flash-latest$/.test(id));
          model = listed.sort((a, b) => (parseFloat(b.replace(/^gemini-/, "")) || 0) - (parseFloat(a.replace(/^gemini-/, "")) || 0) || a.length - b.length)[0] ?? "";
          if (!model) throw new AIProviderError({ provider: "Gemini", model: "catalog", type: "invalid_request", detail: "No audio-capable Gemini model is listed for this key." });
        }
        usedModel = model;
        const response = await provider.transcribeAudio({ model, mimeType, base64: bytes.toString("base64"), ...(languageHint ? { language: languageHint } : {}), signal: req.signal });
        return { transcript: response.content, model: response.model, provider: "Gemini", usage: { ...response.usage, detected_language: languageHint || null } };
      } });
    }
    let out: Transcription | null = null;
    let lastError: unknown = null;
    for (const attempt of attempts) {
      usedModel = attempt.model;
      try {
        out = await attempt.run();
        break;
      } catch (error) {
        lastError = error;
        if (req.signal.aborted) throw error;
        logProviderFailure(error);
      }
    }
    if (!out) throw lastError ?? new Error("VOICE_TRANSCRIPTION_FAILED");

    await d.collection("ai_usage_logs").add({
      user_id: user.uid,
      model: out.model,
      request_type: "voice_transcription",
      token_usage: out.usage,
      latency_ms: Date.now() - startedAt,
      status: "ok",
      created_at: nowTs(),
    }).catch(() => {});

    const language = typeof out.usage.detected_language === "string" ? out.usage.detected_language : null;
    if (audioRef) await audioRef.set({ transcript: out.transcript, detected_language: language, transcription_status: "complete", transcribed_at: nowTs() }, { merge: true });
    return NextResponse.json({
      transcript: out.transcript,
      audio_asset_id: audioRef ? id : null,
      playback_url: audioRef ? `/api/voice/audio/${id}` : null,
      stored: Boolean(audioRef),
      provider: out.provider,
      model: out.model,
      usage: out.usage,
      detected_language: language,
      requested_language: languageHint || "auto",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logProviderFailure(error);
    if (audioRef) await audioRef.set({ transcription_status: "failed" }, { merge: true }).catch(() => {});
    await d.collection("ai_usage_logs").add({
      user_id: user.uid,
      model: usedModel,
      request_type: "voice_transcription",
      token_usage: {},
      latency_ms: Date.now() - startedAt,
      status: "error",
      created_at: nowTs(),
    }).catch(() => {});
    return NextResponse.json(
      { error: providerPublicCode(error), audio_asset_id: audioRef ? id : null, playback_url: audioRef ? `/api/voice/audio/${id}` : null },
      { status: providerStatus(error), headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
