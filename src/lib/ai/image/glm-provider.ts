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
    // A successful GET /models or chat ping does NOT prove that this account
    // can generate images with this model. This explicit Admin test performs
    // one real (billable) image request instead of reporting a false success.
    try {
      const res = await fetch(`${resolveImageBaseUrl()}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "A blue square on a white background", size: "1024x1024" }),
        signal: signal ?? AbortSignal.timeout(60_000),
      });
      const latencyMs = Date.now() - started;
      if (res.status === 401 || res.status === 403) return { ok: false, code: "AUTH_FAILED", latencyMs };
      if (res.status === 429) return { ok: false, code: "RATE_LIMITED", latencyMs };
      if (res.status === 400 || res.status === 404 || res.status === 422) return { ok: false, code: "MODEL_INVALID", latencyMs };
      if (!res.ok) return { ok: false, code: "UNREACHABLE", latencyMs };
      const body = await res.json().catch(() => null) as { data?: Array<{ url?: string; b64_json?: string }> } | null;
      return { ok: Boolean(body?.data?.[0]?.url || body?.data?.[0]?.b64_json), code: body?.data?.[0]?.url || body?.data?.[0]?.b64_json ? "OK" : "UNREACHABLE", latencyMs };
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
