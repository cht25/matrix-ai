"use client";

// Pipeline performance numbers (product spec §22).
// Never rendered on its own: it lives inside the [Performance ▾] toggle of the
// Activity panel, or in the Agent execution view — analytics are opt-in.

import type { PipelineAnalytics } from "@/lib/ai/pipeline";
import { cn } from "@/lib/utils";

export function PipelineAnalyticsPanel({ analytics, compact = false }: { analytics: PipelineAnalytics | null; compact?: boolean }) {
  if (!analytics) return null;
  const rows: Array<[string, string]> = [
    ["Tokens/sec", analytics.tokensPerSec == null ? "—" : String(analytics.tokensPerSec)],
    ["Total tokens", analytics.totalTokens.toLocaleString()],
    ["Total latency", `${(analytics.totalLatencyMs / 1000).toFixed(2)}s`],
  ];
  const detail: Array<[string, string]> = [
    ["Input tokens", analytics.inputTokens.toLocaleString()],
    ["Output tokens", analytics.outputTokens.toLocaleString()],
    ["Time to first", analytics.timeToFirstMs == null ? "—" : `${(analytics.timeToFirstMs / 1000).toFixed(2)}s`],
    ["Agent steps", String(analytics.agentSteps)],
    ["Tools executed", String(analytics.toolsExecuted)],
  ];

  return (
    <dl className={cn("grid gap-x-4 gap-y-1 font-mono text-[11px]", compact ? "mt-1.5 grid-cols-2" : "grid-cols-2")}>
      {[...rows, ...(compact ? detail : [])].map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-2">
          <dt className="text-ink-3">{key}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
