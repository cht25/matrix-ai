// =============================================================================
// Image generation provider abstraction.
//
// The rest of MATRIX talks to `ImageProvider` only — never to Together AI
// directly — so a second provider can be added by implementing this interface
// and registering it in image/registry.ts. No provider name is hard-coded in
// the UI; the admin picks one from the registry.
// =============================================================================

export type ImageProviderId = "together";

export type ImageGenerateOptions = {
  width?: number;
  height?: number;
  signal?: AbortSignal;
};

export type ImageGenerateResult = {
  b64: string;
  mime: "image/png";
  model: string;
  provider: ImageProviderId;
  latencyMs: number;
};

/** Result of a real network probe against the provider. Never fabricated. */
export type ImageProviderStatus = {
  ok: boolean;
  /** Stable machine code; the UI maps it to a human sentence. */
  code: "OK" | "NOT_CONFIGURED" | "AUTH_FAILED" | "RATE_LIMITED" | "MODEL_INVALID" | "UNREACHABLE";
  latencyMs: number;
};

export type ImageProviderCredentials = {
  apiKey: string;
  model: string;
};

export interface ImageProvider {
  readonly id: ImageProviderId;
  readonly label: string;
  /** Models this provider is known to support, for the admin dropdown. */
  readonly models: ReadonlyArray<{ id: string; label: string }>;
  /** Shape-check a key before it is stored (no network call). */
  validate(credentials: ImageProviderCredentials): { ok: boolean; code: string };
  /** Live health probe against the provider API. */
  getStatus(credentials: ImageProviderCredentials, signal?: AbortSignal): Promise<ImageProviderStatus>;
  /** Generate an image. Throws ImageProviderError on failure. */
  generate(
    credentials: ImageProviderCredentials,
    prompt: string,
    options?: ImageGenerateOptions,
  ): Promise<ImageGenerateResult>;
}

/** Errors carry a stable code — never a provider response body or a key. */
export class ImageProviderError extends Error {
  constructor(
    readonly code: "NOT_CONFIGURED" | "AUTH_FAILED" | "RATE_LIMITED" | "UNREACHABLE" | "EMPTY_RESULT" | "MALFORMED",
    readonly provider: ImageProviderId,
  ) {
    super(code);
    this.name = "ImageProviderError";
  }
}

/** Placeholder keys that must never count as "configured". */
const PLACEHOLDERS = ["YOUR-", "replace-with", "sk-...", "..."];

export function isRealSecret(value: unknown): boolean {
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length < 8) return false;
  return !PLACEHOLDERS.some((p) => key.includes(p));
}
