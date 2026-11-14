import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { isCloudinaryConfigured } from "@/lib/env";
import { GeminiProvider } from "@/lib/ai/gemini";
import { matchesAudioContainer } from "@/lib/ai/audio";
import { AIProviderError, logProviderFailure, providerPublicCode, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { deletePrivateAudio, uploadPrivateAudio } from "@/lib/server/cloudinary";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
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
  signal?: AbortSignal;
}): Promise<{ transcript: string; model: string; provider: string; usage: Record<string, unknown> }> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(opts.bytes)], { type: opts.mimeType }), opts.filename);
  fd.append("model", opts.model);
  // No language hint: Whisper detects the spoken language, including code-switching.
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
  return { transcript, model: opts.model, provider: opts.providerLabel, usage: { detected_language: data.language ?? null } };
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

  const hasProvider = Boolean(groqKey || openaiKey || (geminiKey && geminiAudioModel));
  if (!hasProvider) return NextResponse.json({ error: "VOICE_TRANSCRIPTION_NOT_CONFIGURED" }, { status: 503 });
  if (!isCloudinaryConfigured()) return NextResponse.json({ error: "VOICE_STORAGE_NOT_CONFIGURED" }, { status: 503 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) return NextResponse.json({ error: "AUDIO_REQUIRED" }, { status: 400 });
  const mimeType = file.type.toLowerCase().split(";")[0];
  if (!ALLOWED_AUDIO_TYPES.has(mimeType)) return NextResponse.json({ error: "AUDIO_TYPE_UNSUPPORTED" }, { status: 415 });
  if (!file.size || file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: "AUDIO_SIZE_INVALID", max_bytes: MAX_AUDIO_BYTES }, { status: 413 });

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!matchesAudioContainer(bytes, mimeType)) return NextResponse.json({ error: "AUDIO_CONTENT_INVALID" }, { status: 415 });
  let stored: Awaited<ReturnType<typeof uploadPrivateAudio>>;
  try {
    stored = await uploadPrivateAudio(user.uid, bytes, file.name || "voice-recording");
  } catch (error) {
    console.error("[MATRIX] private voice upload failed", { uid: user.uid, detail: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return NextResponse.json({ error: "VOICE_UPLOAD_FAILED" }, { status: 502 });
  }

  const d = adminDb();
  const id = randomUUID();
  const audioRef = d.collection("chat_audio_assets").doc(id);
  const createdAt = nowTs();
  try {
    await audioRef.create({
      user_id: user.uid,
      storage_provider: "cloudinary",
      storage_public_id: stored.publicId,
      storage_version: stored.version,
      storage_format: stored.format,
      mime_type: file.type || mimeType,
      bytes: stored.bytes,
      created_at: createdAt,
    });
  } catch (error) {
    await deletePrivateAudio(stored.publicId);
    console.error("[MATRIX] voice metadata persistence failed", { uid: user.uid, detail: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return NextResponse.json({ error: "VOICE_STORAGE_FAILED" }, { status: 503 });
  }

  const startedAt = Date.now();
  const filename = file.name || "voice.webm";
  let usedModel = "whisper-large-v3-turbo";

  try {
    let out: { transcript: string; model: string; provider: string; usage: Record<string, unknown> };
    if (groqKey) {
      usedModel = process.env.GROQ_AUDIO_MODEL?.trim() || "whisper-large-v3-turbo";
      out = await transcribeViaOpenAICompatible({
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: groqKey,
        providerLabel: "Groq",
        model: usedModel,
        bytes,
        filename,
        mimeType,
        signal: req.signal,
      });
    } else if (openaiKey) {
      usedModel = process.env.OPENAI_AUDIO_MODEL?.trim() || "whisper-1";
      out = await transcribeViaOpenAICompatible({
        baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
        apiKey: openaiKey,
        providerLabel: "OpenAI",
        model: usedModel,
        bytes,
        filename,
        mimeType,
        signal: req.signal,
      });
    } else {
      usedModel = geminiAudioModel;
      const provider = new GeminiProvider(geminiKey);
      const response = await provider.transcribeAudio({
        model: usedModel,
        mimeType,
        base64: bytes.toString("base64"),
        signal: req.signal,
      });
      out = { transcript: response.content, model: response.model, provider: "Gemini", usage: response.usage };
    }

    await d.collection("ai_usage_logs").add({
      user_id: user.uid,
      model: out.model,
      request_type: "voice_transcription",
      token_usage: out.usage,
      latency_ms: Date.now() - startedAt,
      status: "ok",
      created_at: nowTs(),
    }).catch(() => {});

    return NextResponse.json({
      transcript: out.transcript,
      audio_asset_id: id,
      playback_url: `/api/voice/audio/${id}`,
      provider: out.provider,
      model: out.model,
      usage: out.usage,
      detected_language: typeof out.usage.detected_language === "string" ? out.usage.detected_language : null,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logProviderFailure(error);
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
      { error: providerPublicCode(error), audio_asset_id: id, playback_url: `/api/voice/audio/${id}` },
      { status: providerStatus(error), headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
