// =============================================================================
// GLM (Zhipu AI / Z.ai CogView) implementation of the ImageProvider interface.
//
// Primary image generation provider for MATRIX AI. Calls GLM's official
// `/images/generations` endpoint on the server and normalizes either `b64_json`
// or signed image `url` responses into base64 bytes so credentials and upstream
// signed URLs never leak to the browser.
// =============================================================================

import "server-only";
import { resolveGlmBaseUrl } from "@/lib/ai/glm";
import { normalizeCompatibleBaseUrl } from "@/lib/ai/openai";
import {
  ImageProviderError,
  isRealSecret,
  type ImageGenerateOptions,
  type ImageGenerateResult,
  type ImageProvider,
  type ImageProviderCredentials,
  type ImageProviderStatus,
} from "@/lib/ai/image/provider";

export const GLM_IMAGE_DEFAULT_MODEL = "cogview-4";

const MODELS = [
  { id: "cogview-4", label: "GLM CogView-4 (Primary)" },
  { id: "glm-image", label: "GLM Image" },
  { id: "cogview-4-250304", label: "GLM CogView-4 (250304)" },
  { id: "cogview-3-flash", label: "GLM CogView-3 Flash (Fast)" },
] as const;

function resolveImageBaseUrl(): string {
  const explicit = (process.env.GLM_IMAGE_BASE_URL || "").trim();
  if (explicit) return normalizeCompatibleBaseUrl(explicit) || resolveGlmBaseUrl();
  return resolveGlmBaseUrl();
}

function errorFor(status: number): ImageProviderError["code"] {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "UNREACHABLE";
}

function normalizeGlmSize(width?: number, height?: number): string {
  const w = Math.min(1440, Math.max(512, Math.round((width ?? 1024) / 16) * 16));
  const h = Math.min(1440, Math.max(512, Math.round((height ?? 1024) / 16) * 16));
  return `${w}x${h}`;
}

export const glmImageProvider: ImageProvider = {
  id: "glm",
  label: "GLM (Zhipu / Z.ai)",
  models: MODELS,

  validate({ apiKey, model }) {
    if (!isRealSecret(apiKey)) return { ok: false, code: "API_KEY_REQUIRED" };
    if (!model.trim() || model.length > 200) return { ok: false, code: "MODEL_INVALID" };
    return { ok: true, code: "OK" };
  },

  async getStatus({ apiKey, model }, signal): Promise<ImageProviderStatus> {
    const started = Date.now();
    if (!isRealSecret(apiKey)) return { ok: false, code: "NOT_CONFIGURED", latencyMs: 0 };
    if (!model.trim() || model.length > 200) return { ok: false, code: "MODEL_INVALID", latencyMs: 0 };
    const base = resolveImageBaseUrl();
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - started;
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: "AUTH_FAILED", latencyMs };
      }
      if (res.status === 429) {
        return { ok: false, code: "RATE_LIMITED", latencyMs };
      }
      // Some regional GLM PaaS gateways return 404 on GET /models while serving
      // POST /images/generations; probe auth via minimal chat ping if /models is 404.
      if (res.status === 404) {
        const probe = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "glm-4.5-air", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
          signal: signal ?? AbortSignal.timeout(12_000),
        });
        const probeLatency = Date.now() - started;
        if (probe.status === 401 || probe.status === 403) return { ok: false, code: "AUTH_FAILED", latencyMs: probeLatency };
        if (probe.status === 429) return { ok: false, code: "RATE_LIMITED", latencyMs: probeLatency };
        return { ok: probe.ok || probe.status === 400, code: probe.ok || probe.status === 400 ? "OK" : "UNREACHABLE", latencyMs: probeLatency };
      }
      if (!res.ok) return { ok: false, code: "UNREACHABLE", latencyMs };
      return { ok: true, code: "OK", latencyMs };
    } catch {
      return { ok: false, code: "UNREACHABLE", latencyMs: Date.now() - started };
    }
  },

  async generate(
    { apiKey, model }: ImageProviderCredentials,
    prompt: string,
    options?: ImageGenerateOptions,
  ): Promise<ImageGenerateResult> {
    if (!isRealSecret(apiKey)) throw new ImageProviderError("NOT_CONFIGURED", "glm");
    const started = Date.now();
    const base = resolveImageBaseUrl();
    const resolvedModel = model?.trim() || GLM_IMAGE_DEFAULT_MODEL;
    const size = normalizeGlmSize(options?.width, options?.height);

    let res: Response;
    try {
      res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: options?.signal ?? AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: resolvedModel,
          prompt: prompt.slice(0, 4000),
          size,
        }),
      });
    } catch {
      throw new ImageProviderError("UNREACHABLE", "glm");
    }

    if (!res.ok) throw new ImageProviderError(errorFor(res.status), "glm");

    let parsed: { data?: Array<{ b64_json?: string; url?: string }> };
    try {
      parsed = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    } catch {
      throw new ImageProviderError("MALFORMED", "glm");
    }

    const first = parsed.data?.[0];
    let b64 = first?.b64_json?.trim() ?? "";

    if (!b64 && first?.url) {
      let imgRes: Response;
      try {
        imgRes = await fetch(first.url, { signal: options?.signal ?? AbortSignal.timeout(60_000) });
      } catch {
        throw new ImageProviderError("UNREACHABLE", "glm");
      }
      if (!imgRes.ok) throw new ImageProviderError("UNREACHABLE", "glm");
      const bytes = Buffer.from(await imgRes.arrayBuffer());
      if (!bytes.length) throw new ImageProviderError("EMPTY_RESULT", "glm");
      b64 = bytes.toString("base64");
    }

    if (!b64) throw new ImageProviderError("EMPTY_RESULT", "glm");

    return {
      b64,
      mime: "image/png",
      model: resolvedModel,
      provider: "glm",
      latencyMs: Date.now() - started,
    };
  },
};
