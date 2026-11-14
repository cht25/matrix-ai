"use client";

// Admin → AI configuration.
//
//   Overview  · live provider status dashboard
//   Model     · the single MATRIX model (GPT OSS 120B) — read-only status
//   Image     · image generation service (Together AI)
//   Usage     · real gateway call log
//
// Panels are code-split: opening AI configuration no longer downloads the
// image, text and usage panels up-front.

import { Suspense, lazy, useState } from "react";
import { Spinner } from "@/components/ui";
import { ProviderStatus } from "@/components/admin/provider-status";
import { cn } from "@/lib/utils";

const ModelsClient = lazy(() =>
  import("@/components/models-client").then((m) => ({ default: m.ModelsClient })),
);
const ImageProviderSettings = lazy(() =>
  import("@/components/admin/image-provider-settings").then((m) => ({ default: m.ImageProviderSettings })),
);
const AiUsagePanel = lazy(() =>
  import("@/components/admin/ai-usage-panel").then((m) => ({ default: m.AiUsagePanel })),
);
const AppReleaseSettings = lazy(() =>
  import("@/components/admin/app-release-settings").then((m) => ({ default: m.AppReleaseSettings })),
);

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "text", label: "AI model" },
  { id: "image", label: "Image generation" },
  { id: "updates", label: "Phone & Updates" },
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
        {tab === "text" ? <ModelsClient showChatLink={false} /> : null}
        {tab === "image" ? <ImageProviderSettings /> : null}
        {tab === "updates" ? <AppReleaseSettings /> : null}
        {tab === "usage" ? <AiUsagePanel /> : null}
      </Suspense>
    </div>
  );
}
