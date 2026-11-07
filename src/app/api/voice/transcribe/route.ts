import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { isCloudinaryConfigured } from "@/lib/env";
import { GeminiProvider } from "@/lib/ai/gemini";
import { AIProviderError, logProviderFailure, providerPublicCode } from "@/lib/ai/provider-error";
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

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const key = process.env.GEMINI_API_KEY?.trim() ?? "";
  const model = process.env.GEMINI_AUDIO_MODEL?.trim() ?? "";
  if (!key || !model) return NextResponse.json({ error: "VOICE_TRANSCRIPTION_NOT_CONFIGURED" }, { status: 503 });
  if (!isCloudinaryConfigured()) return NextResponse.json({ error: "VOICE_STORAGE_NOT_CONFIGURED" }, { status: 503 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) return NextResponse.json({ error: "AUDIO_REQUIRED" }, { status: 400 });
  const mimeType = file.type.toLowerCase().split(";")[0];
  if (!ALLOWED_AUDIO_TYPES.has(mimeType)) return NextResponse.json({ error: "AUDIO_TYPE_UNSUPPORTED" }, { status: 415 });
  if (!file.size || file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: "AUDIO_SIZE_INVALID", max_bytes: MAX_AUDIO_BYTES }, { status: 413 });

  const provider = new GeminiProvider(key);
  try {
    const models = await provider.listModels();
    if (!models.some((entry) => entry.id === model)) return NextResponse.json({ error: "GEMINI_AUDIO_MODEL_NOT_AVAILABLE" }, { status: 503 });
  } catch (error) {
    logProviderFailure(error);
    return NextResponse.json({ error: providerPublicCode(error) }, { status: providerStatus(error) });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
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
  try {
    const response = await provider.transcribeAudio({
      model,
      mimeType,
      base64: bytes.toString("base64"),
      language: typeof form?.get("language") === "string" ? String(form.get("language")) : undefined,
      signal: req.signal,
    });
    await d.collection("ai_usage_logs").add({
      user_id: user.uid,
      model: response.model,
      request_type: "voice_transcription",
      token_usage: response.usage,
      latency_ms: Date.now() - startedAt,
      status: "ok",
      created_at: nowTs(),
    }).catch(() => {});
    return NextResponse.json({
      transcript: response.content,
      audio_asset_id: id,
      playback_url: `/api/voice/audio/${id}`,
      provider: "Gemini",
      model: response.model,
      usage: response.usage,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logProviderFailure(error);
    await d.collection("ai_usage_logs").add({
      user_id: user.uid,
      model,
      request_type: "voice_transcription",
      token_usage: {},
      latency_ms: Date.now() - startedAt,
      status: "error",
      created_at: nowTs(),
    }).catch(() => {});
    // The private upload remains available to the owner, so a transient ASR
    // failure never silently discards a recording.
    return NextResponse.json({ error: providerPublicCode(error), audio_asset_id: id, playback_url: `/api/voice/audio/${id}` }, { status: providerStatus(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
