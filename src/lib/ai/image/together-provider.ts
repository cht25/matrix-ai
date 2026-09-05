// Together AI implementation of the ImageProvider interface.
// Server-side only — the API key never leaves this process.

import "server-only";
import {
  ImageProviderError,
  isRealSecret,
  type ImageGenerateOptions,
  type ImageGenerateResult,
  type ImageProvider,
  type ImageProviderCredentials,
  type ImageProviderStatus,
} from "@/lib/ai/image/provider";

const BASE = "https://api.together.xyz/v1";

export const TOGETHER_DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell-Free";

const MODELS = [
  { id: "black-forest-labs/FLUX.1-schnell-Free", label: "FLUX.1 schnell (free)" },
  { id: "black-forest-labs/FLUX.1-schnell", label: "FLUX.1 schnell" },
  { id: "black-forest-labs/FLUX.1-dev", label: "FLUX.1 dev" },
  { id: "black-forest-labs/FLUX.1.1-pro", label: "FLUX.1.1 pro" },
  { id: "stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL 1.0" },
] as const;

function errorFor(status: number): ImageProviderError["code"] {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "UNREACHABLE";
}

export const togetherImageProvider: ImageProvider = {
  id: "together",
  label: "Together AI",
  models: MODELS,

  validate({ apiKey, model }) {
    if (!isRealSecret(apiKey)) return { ok: false, code: "API_KEY_REQUIRED" };
    if (!model.trim() || model.length > 200) return { ok: false, code: "MODEL_INVALID" };
    return { ok: true, code: "OK" };
  },

  /**
   * Real health probe: list the account's models. A 200 proves the key is
   * accepted by Together AI right now — nothing here is assumed or cached.
   */
  async getStatus({ apiKey, model }, signal): Promise<ImageProviderStatus> {
    const started = Date.now();
    if (!isRealSecret(apiKey)) return { ok: false, code: "NOT_CONFIGURED", latencyMs: 0 };
    try {
      const res = await fetch(`${BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return { ok: false, code: res.status === 401 || res.status === 403 ? "AUTH_FAILED" : res.status === 429 ? "RATE_LIMITED" : "UNREACHABLE", latencyMs };
      }
      // Confirm the configured model actually exists on the account.
      const body = (await res.json().catch(() => null)) as Array<{ id?: string }> | { data?: Array<{ id?: string }> } | null;
      const list = Array.isArray(body) ? body : (body?.data ?? []);
      const known = list.some((m) => m?.id === model);
      if (list.length > 0 && !known) return { ok: false, code: "MODEL_INVALID", latencyMs };
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
    if (!isRealSecret(apiKey)) throw new ImageProviderError("NOT_CONFIGURED", "together");
    const started = Date.now();
    const width = Math.min(1440, Math.max(256, options?.width ?? 1024));
    const height = Math.min(1440, Math.max(256, options?.height ?? 1024));

    let res: Response;
    try {
      res = await fetch(`${BASE}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: options?.signal ?? AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: model || TOGETHER_DEFAULT_MODEL,
          prompt: prompt.slice(0, 4000),
          width,
          height,
          steps: 4,
          n: 1,
          response_format: "b64_json",
        }),
      });
    } catch {
      throw new ImageProviderError("UNREACHABLE", "together");
    }

    if (!res.ok) throw new ImageProviderError(errorFor(res.status), "together");

    let parsed: { data?: Array<{ b64_json?: string }> };
    try {
      parsed = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    } catch {
      throw new ImageProviderError("MALFORMED", "together");
    }
    const b64 = parsed.data?.[0]?.b64_json;
    if (!b64) throw new ImageProviderError("EMPTY_RESULT", "together");

    return {
      b64,
      mime: "image/png",
      model: model || TOGETHER_DEFAULT_MODEL,
      provider: "together",
      latencyMs: Date.now() - started,
    };
  },
};
