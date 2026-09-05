// Registry of available image providers. Adding a provider means implementing
// ImageProvider and adding one line here — no UI or call-site changes needed.

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
