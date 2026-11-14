// Registry of image-generation providers. Image generation is a media service,
// not a language model: prompts are still written/understood by GPT OSS 120B.

import "server-only";
import type { ImageProvider, ImageProviderId } from "@/lib/ai/image/provider";
import { togetherImageProvider } from "@/lib/ai/image/together-provider";

const PROVIDERS: Record<ImageProviderId, ImageProvider> = {
  together: togetherImageProvider,
};

export function getImageProvider(id: ImageProviderId): ImageProvider {
  return PROVIDERS[id] ?? togetherImageProvider;
}

export function listImageProviders(): Array<{ id: ImageProviderId; label: string; models: Array<{ id: string; label: string }> }> {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, models: [...p.models] }));
}
