// Together AI image generation — server-side only. Never import from client.

export const TOGETHER_IMAGE_MODEL =
  process.env.TOGETHER_IMAGE_MODEL?.trim() || "black-forest-labs/FLUX.1-schnell-Free";

export type TogetherImageResult = {
  b64: string;
  mime: "image/png";
  model: string;
  latencyMs: number;
};

function togetherKey(): string {
  return (process.env.TOGETHER_API_KEY ?? "").trim();
}

export function isTogetherConfigured(): boolean {
  const key = togetherKey();
  return Boolean(key) && !key.endsWith("...") && !key.startsWith("YOUR-") && !key.startsWith("replace-with");
}

export async function generateTogetherImage(prompt: string, opts?: { width?: number; height?: number; signal?: AbortSignal }): Promise<TogetherImageResult> {
  const key = togetherKey();
  if (!key) {
    const err = new Error("TOGETHER_NOT_CONFIGURED");
    err.name = "TogetherConfigError";
    throw err;
  }
  const started = Date.now();
  const width = Math.min(1440, Math.max(256, opts?.width ?? 1024));
  const height = Math.min(1440, Math.max(256, opts?.height ?? 1024));
  const res = await fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    signal: opts?.signal,
    body: JSON.stringify({
      model: TOGETHER_IMAGE_MODEL,
      prompt: prompt.slice(0, 4000),
      width,
      height,
      steps: 4,
      n: 1,
      response_format: "b64_json",
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(res.status === 401 || res.status === 403 ? "TOGETHER_AUTH_FAILED" : res.status === 429 ? "TOGETHER_RATE_LIMITED" : "TOGETHER_UNAVAILABLE");
    err.name = "TogetherApiError";
    throw err;
  }
  let parsed: { data?: Array<{ b64_json?: string; url?: string }> };
  try {
    parsed = JSON.parse(raw) as { data?: Array<{ b64_json?: string; url?: string }> };
  } catch {
    throw Object.assign(new Error("TOGETHER_MALFORMED"), { name: "TogetherApiError" });
  }
  const b64 = parsed.data?.[0]?.b64_json;
  if (!b64 || typeof b64 !== "string") {
    throw Object.assign(new Error("TOGETHER_EMPTY"), { name: "TogetherApiError" });
  }
  return { b64, mime: "image/png", model: TOGETHER_IMAGE_MODEL, latencyMs: Date.now() - started };
}
