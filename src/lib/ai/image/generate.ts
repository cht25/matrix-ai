// The single entry point every MATRIX feature uses to generate an image.
// Resolves the admin-configured provider + credentials, then delegates.

import "server-only";
import type { Db } from "@/lib/firebase/admin";
import { ImageProviderError, type ImageGenerateOptions, type ImageGenerateResult } from "@/lib/ai/image/provider";
import { getImageProvider } from "@/lib/ai/image/registry";
import { resolveImageCredentials } from "@/lib/ai/image/config";

export async function generateImage(
  d: Db,
  prompt: string,
  options?: ImageGenerateOptions,
): Promise<ImageGenerateResult> {
  const resolved = await resolveImageCredentials(d);
  if (!resolved) throw new ImageProviderError("NOT_CONFIGURED", "together");
  const provider = getImageProvider(resolved.provider);
  return provider.generate(resolved.credentials, prompt, options);
}

/** Map a provider error to a stable, user-safe gateway code. */
export function imageErrorCode(error: unknown): string {
  if (error instanceof ImageProviderError) {
    return error.code === "NOT_CONFIGURED" ? "IMAGE_NOT_CONFIGURED" : `IMAGE_${error.code}`;
  }
  return "IMAGE_UNAVAILABLE";
}
