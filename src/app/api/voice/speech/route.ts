import { NextRequest, NextResponse } from "next/server";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { resolveGlmBaseUrl } from "@/lib/ai/glm";
import { GeminiProvider } from "@/lib/ai/gemini";
import { pcm16ToWav } from "@/lib/ai/audio";
import { AIProviderError, logProviderFailure, providerErrorFromResponse, providerPublicCode } from "@/lib/ai/provider-error";
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

function keyPresent(v: string | undefined): string {
  const s = v?.trim() ?? "";
  return s && !s.endsWith("...") && !s.startsWith("YOUR-") && !s.startsWith("replace-with") ? s : "";
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const glmKey = keyPresent(process.env.GLM_API_KEY);
  const glmTtsModel = process.env.GLM_TTS_MODEL?.trim() ?? "";
  const openaiKey = keyPresent(process.env.OPENAI_API_KEY);
  const openaiTtsModel = process.env.OPENAI_TTS_MODEL?.trim() ?? "";
  const geminiKey = keyPresent(process.env.GEMINI_API_KEY);
  const geminiModel = process.env.GEMINI_TTS_MODEL?.trim() ?? "";
  const geminiVoice = process.env.GEMINI_TTS_VOICE?.trim() ?? "";

  if (!(glmKey && glmTtsModel) && !(openaiKey && openaiTtsModel) && !(geminiKey && geminiModel && geminiVoice)) {
    return NextResponse.json({ error: "VOICE_TTS_NOT_CONFIGURED" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({})) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "TEXT_REQUIRED" }, { status: 400 });
  if (text.length > 6000) return NextResponse.json({ error: "TEXT_TOO_LONG" }, { status: 413 });

  const startedAt = Date.now();
  const activeModel = (glmKey && glmTtsModel) ? glmTtsModel : (openaiKey && openaiTtsModel) ? openaiTtsModel : geminiModel;

  try {
    if ((glmKey && glmTtsModel) || (openaiKey && openaiTtsModel)) {
      const useGlm = Boolean(glmKey && glmTtsModel);
      const baseUrl = useGlm ? resolveGlmBaseUrl() : (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1");
      const apiKey = useGlm ? glmKey : openaiKey;
      const voice = (useGlm ? process.env.GLM_TTS_VOICE : process.env.OPENAI_TTS_VOICE)?.trim() || "alloy";
      const providerName = useGlm ? "GLM" : "OpenAI";

      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: activeModel, input: text, voice, response_format: "wav" }),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw providerErrorFromResponse(providerName, activeModel, res, detail);
      }
      const audioBytes = new Uint8Array(await res.arrayBuffer());
      await adminDb().collection("ai_usage_logs").add({
        user_id: user.uid,
        model: activeModel,
        request_type: "voice_synthesis",
        token_usage: {},
        latency_ms: Date.now() - startedAt,
        status: "ok",
        created_at: nowTs(),
      }).catch(() => {});
      return new NextResponse(audioBytes, {
        headers: {
          "Content-Type": res.headers.get("content-type") || "audio/wav",
          "Content-Length": String(audioBytes.byteLength),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "X-MATRIX-Provider": providerName,
          "X-MATRIX-Model": activeModel,
        },
      });
    }

    const provider = new GeminiProvider(geminiKey);
    const models = await provider.listModels();
    if (!models.some((entry) => entry.id === geminiModel)) {
      return NextResponse.json({ error: "VOICE_TTS_MODEL_NOT_AVAILABLE" }, { status: 503 });
    }
    const result = await provider.synthesizeSpeech({ model: geminiModel, text, voice: geminiVoice, signal: req.signal });
    const wav = pcm16ToWav(result.bytes, result.mimeType);
    await adminDb().collection("ai_usage_logs").add({
      user_id: user.uid,
      model: geminiModel,
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
        "X-MATRIX-Model": geminiModel,
      },
    });
  } catch (error) {
    logProviderFailure(error);
    await adminDb().collection("ai_usage_logs").add({
      user_id: user.uid,
      model: activeModel,
      request_type: "voice_synthesis",
      token_usage: {},
      latency_ms: Date.now() - startedAt,
      status: "error",
      created_at: nowTs(),
    }).catch(() => {});
    return NextResponse.json({ error: providerPublicCode(error) }, { status: providerStatus(error), headers: { "Cache-Control": "private, no-store" } });
  }
}
