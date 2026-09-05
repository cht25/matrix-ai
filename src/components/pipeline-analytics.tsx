"use client";

import type { PipelineAnalytics } from "@/lib/ai/pipeline";
import { emptyAnalytics } from "@/lib/ai/pipeline";

export function PipelineAnalyticsPanel({ analytics }: { analytics: PipelineAnalytics | null }) {
  const a = analytics ?? emptyAnalytics();
  const rows: Array<[string, string]> = [
    ["Tokens/sec", a.tokensPerSec == null ? "—" : String(a.tokensPerSec)],
    ["Input tokens", a.inputTokens.toLocaleString()],
    ["Output tokens", a.outputTokens.toLocaleString()],
    ["Total tokens", a.totalTokens.toLocaleString()],
    ["Time to first", a.timeToFirstMs == null ? "—" : `${(a.timeToFirstMs / 1000).toFixed(2)}s`],
    ["Total latency", `${(a.totalLatencyMs / 1000).toFixed(2)}s`],
    ["Agent steps", String(a.agentSteps)],
    ["Tools executed", String(a.toolsExecuted)],
  ];
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <p className="eyebrow mb-2">Pipeline performance</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2">
            <dt className="text-ink-3">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
