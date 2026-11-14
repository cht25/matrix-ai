import { NextRequest, NextResponse } from "next/server";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
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

  // Text-to-speech is a speech service, not a language model. The only
  // server voice is an OpenAI-compatible speech endpoint; without it the
  // browser's built-in speech synthesis is used by the client.
  const openaiKey = keyPresent(process.env.OPENAI_API_KEY);
  const openaiTtsModel = process.env.OPENAI_TTS_MODEL?.trim() ?? "";
  if (!(openaiKey && openaiTtsModel)) {
    return NextResponse.json({ error: "VOICE_TTS_NOT_CONFIGURED" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({})) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "TEXT_REQUIRED" }, { status: 400 });
  if (text.length > 6000) return NextResponse.json({ error: "TEXT_TOO_LONG" }, { status: 413 });

  const startedAt = Date.now();
  const activeModel = openaiTtsModel;

  try {
    {
      const baseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
      const apiKey = openaiKey;
      const voice = process.env.OPENAI_TTS_VOICE?.trim() || "alloy";
      const providerName = "OpenAI" as const;

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
