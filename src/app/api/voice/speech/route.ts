import { NextRequest, NextResponse } from "next/server";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { GeminiProvider } from "@/lib/ai/gemini";
import { pcm16ToWav } from "@/lib/ai/audio";
import { AIProviderError, logProviderFailure, providerPublicCode } from "@/lib/ai/provider-error";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function providerStatus(error: unknown): number {
  if (error instanceof AIProviderError) {
    if (error.type === "authentication") return 503;
    if (error.type === "timeout") return 504;
    if (error.type === "invalid_request") return 400;
    if (["rate_limit", "billing", "provider_unavailable"].includes(error.type)) return 503;
  }
  return 502;
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const key = process.env.GEMINI_API_KEY?.trim() ?? "";
  const model = process.env.GEMINI_TTS_MODEL?.trim() ?? "";
  const voice = process.env.GEMINI_TTS_VOICE?.trim() ?? "";
  if (!key || !model || !voice) return NextResponse.json({ error: "VOICE_TTS_NOT_CONFIGURED" }, { status: 503 });

  const body = await req.json().catch(() => ({})) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "TEXT_REQUIRED" }, { status: 400 });
  if (text.length > 6000) return NextResponse.json({ error: "TEXT_TOO_LONG" }, { status: 413 });

  const provider = new GeminiProvider(key);
  const startedAt = Date.now();
  try {
    const models = await provider.listModels();
    if (!models.some((entry) => entry.id === model)) return NextResponse.json({ error: "GEMINI_TTS_MODEL_NOT_AVAILABLE" }, { status: 503 });
    const result = await provider.synthesizeSpeech({ model, text, voice, signal: req.signal });
    const wav = pcm16ToWav(result.bytes, result.mimeType);
    await adminDb().collection("ai_usage_logs").add({
      user_id: user.uid,
      model,
      request_type: "voice_synthesis",
      token_usage: result.usage,
      latency_ms: Date.now() - startedAt,
      status: "ok",
      created_at: nowTs(),
    }).catch(() => {});
    return new NextResponse(new Uint8Array(wav), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-MATRIX-Provider": "Gemini",
        "X-MATRIX-Model": model,
      },
    });
  } catch (error) {
    logProviderFailure(error);
    await adminDb().collection("ai_usage_logs").add({
      user_id: user.uid,
      model,
      request_type: "voice_synthesis",
      token_usage: {},
      latency_ms: Date.now() - startedAt,
      status: "error",
      created_at: nowTs(),
    }).catch(() => {});
    return NextResponse.json({ error: providerPublicCode(error) }, { status: providerStatus(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
