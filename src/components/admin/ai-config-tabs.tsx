"use client";

// Admin → AI configuration.
//
//   Overview  · live provider status dashboard
//   Text      · OpenAI-compatible chat provider
//   Image     · image generation provider (Together AI, extensible)
//   Usage     · real gateway call log
//
// Panels are code-split: opening AI configuration no longer downloads the
// image, text and usage panels up-front.

import { Suspense, lazy, useState } from "react";
import { Spinner } from "@/components/ui";
import { ProviderStatus } from "@/components/admin/provider-status";
import { cn } from "@/lib/utils";

const AiProviderSettings = lazy(() =>
  import("@/components/admin/ai-provider-settings").then((m) => ({ default: m.AiProviderSettings })),
);
const ImageProviderSettings = lazy(() =>
  import("@/components/admin/image-provider-settings").then((m) => ({ default: m.ImageProviderSettings })),
);
const AiUsagePanel = lazy(() =>
  import("@/components/admin/ai-usage-panel").then((m) => ({ default: m.AiUsagePanel })),
);

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "text", label: "Text models" },
  { id: "image", label: "Image generation" },
  { id: "usage", label: "Usage" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function Loading() {
  return <span className="inline-status"><Spinner /> Loading…</span>;
}

export function AiConfigTabs({ initialTab = "overview" }: { initialTab?: TabId }) {
  const [tab, setTab] = useState<TabId>(initialTab);

  return (
    <div className="space-y-5">
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1" role="tablist" aria-label="AI configuration sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn("ws-tab shrink-0")}
            {...(tab === t.id ? { "aria-pressed": true } : {})}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Suspense fallback={<Loading />}>
        {tab === "overview" ? <ProviderStatus /> : null}
        {tab === "text" ? <AiProviderSettings /> : null}
        {tab === "image" ? <ImageProviderSettings /> : null}
        {tab === "usage" ? <AiUsagePanel /> : null}
      </Suspense>
    </div>
  );
}
