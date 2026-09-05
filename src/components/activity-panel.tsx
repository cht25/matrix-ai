"use client";

// =============================================================================
// Activity + performance disclosures (product spec §12, §22)
//
// Reasoning is never rendered. What the user can opt into is a short list of
// high-level execution events ("Processing request", "Executing tool") plus
// real performance numbers behind a second toggle. Both stay closed by
// default, and neither is mounted at all until the user opens it.
// =============================================================================

import { useState } from "react";
import { Activity as ActivityIcon, ChevronDown, Gauge } from "lucide-react";
import { activityLines, hasExecutionDetail, type ExecutionState } from "@/lib/ai/artifacts";
import { PipelineAnalyticsPanel } from "@/components/pipeline-analytics";
import { BottomSheet } from "@/components/bottom-sheet";
import { useIsCompact } from "@/lib/client/use-media-query";
import { cn } from "@/lib/utils";

const TOGGLE =
  "inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink";

export function ActivityDisclosure({ execution, className }: { execution: ExecutionState; className?: string }) {
  const [open, setOpen] = useState(false);
  // On phones the activity log opens as a bottom sheet instead of expanding
  // inline, so it never pushes the conversation off screen.
  const compact = useIsCompact();
  if (!hasExecutionDetail(execution)) return null;
  const lines = open ? activityLines(execution) : [];

  return (
    <div className={cn("mt-1.5", className)}>
      <button
        type="button"
        className={cn(TOGGLE, open && "bg-surface-2 text-ink")}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Execution activity"
      >
        <ActivityIcon size={12} strokeWidth={1.8} aria-hidden="true" />
        Activity
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && !compact ? (
        <div className="activity-panel mt-1.5 max-w-xl px-3 py-2">
          <p className="eyebrow mb-1.5">Activity</p>
          <ActivityLines lines={lines} />
          <PerformanceDisclosure execution={execution} />
        </div>
      ) : null}

      {compact ? (
        <BottomSheet open={open} onClose={() => setOpen(false)} title="Activity">
          <div className="px-1 pb-2">
            <ActivityLines lines={lines} />
            <PerformanceDisclosure execution={execution} />
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}

function ActivityLines({ lines }: { lines: ReturnType<typeof activityLines> }) {
  if (lines.length === 0) {
    return <p className="text-[11.5px] text-ink-3">No execution steps were recorded.</p>;
  }
  return (
    <ul className="grid gap-1">
      {lines.map((line, index) => (
        <li key={`${line.at}-${index}`} className="flex items-center gap-2 text-[11.5px] text-ink-2">
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              line.state === "active" ? "bg-accent pulse-dot" : line.state === "failed" ? "bg-danger" : "bg-success",
            )}
          />
          <span className={cn("min-w-0 flex-1 truncate", line.state === "active" && "font-medium text-ink")}>{line.label}</span>
          <span className="mono shrink-0 text-[10px] text-ink-3">
            {new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Real numbers, only when they exist, only behind an explicit toggle. */
export function PerformanceDisclosure({ execution, className }: { execution: ExecutionState; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!execution.analytics) return null;

  return (
    <div className={cn("mt-2 border-t border-border pt-1.5", className)}>
      <button
        type="button"
        className={cn(TOGGLE, "!px-0", open && "text-ink")}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Performance details"
      >
        <Gauge size={12} strokeWidth={1.8} aria-hidden="true" />
        Performance
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? <PipelineAnalyticsPanel analytics={execution.analytics} compact /> : null}
    </div>
  );
}
