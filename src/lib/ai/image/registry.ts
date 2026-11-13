// Registry of available image providers. GLM is the primary shipped provider;
// Together AI remains available as an optional admin-selectable alternative.

import "server-only";
import type { ImageProvider, ImageProviderId } from "@/lib/ai/image/provider";
import { glmImageProvider } from "@/lib/ai/image/glm-provider";
import { togetherImageProvider } from "@/lib/ai/image/together-provider";

const PROVIDERS: Record<ImageProviderId, ImageProvider> = {
  glm: glmImageProvider,
  together: togetherImageProvider,
};

export function getImageProvider(id: ImageProviderId): ImageProvider {
  return PROVIDERS[id] ?? glmImageProvider;
}

export function listImageProviders(): Array<{ id: ImageProviderId; label: string; models: Array<{ id: string; label: string }> }> {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, models: [...p.models] }));
}
