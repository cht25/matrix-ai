"use client";

// =============================================================================
// Agent execution surface (product spec §10, §11)
//
// The sandbox is contextual and collapsed by default:
//
//   • It is only mounted while an Agent task really is (or just was) running.
//   • While running it shows the live stage list.
//   • When the task finishes it collapses to one quiet line — "Agent task
//     completed [View]" — so the answer stays the most important element.
//
// Only high-level stage state is shown. No reasoning traces, ever.
// =============================================================================

import { useEffect, useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { AGENT_STAGES, type AgentNodeState, type AgentStageId } from "@/lib/ai/pipeline";
import type { ExecutionState } from "@/lib/ai/artifacts";
import { PerformanceDisclosure } from "@/components/activity-panel";
import { cn } from "@/lib/utils";

export function stageStates(activeStage: AgentStageId | "complete" | null, failed = false): AgentNodeState[] {
  const order = AGENT_STAGES.map((stage) => stage.id);
  const activeIdx = activeStage === "complete" ? order.length : activeStage ? order.indexOf(activeStage) : -1;
  return AGENT_STAGES.map((_, index) => {
    if (failed && index === Math.max(activeIdx, 0)) return "failed";
    if (activeStage === "complete") return "completed";
    if (activeIdx < 0) return "queued";
    if (index < activeIdx) return "completed";
    if (index === activeIdx) return "running";
    return "waiting";
  });
}

/** The ✓ / ● / ○ stage list. Rendered only inside an expanded Agent card. */
export function AgentStageList({ stage, tool, failed }: { stage: AgentStageId | "complete" | null; tool?: string | null; failed?: boolean }) {
  const states = stageStates(stage, failed);
  return (
    <ol className="grid gap-1.5">
      {AGENT_STAGES.map((item, index) => {
        const state = states[index];
        return (
          <li key={item.id} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]", nodeClass(state))}>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(state))} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium">{item.node}</span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-ink-3">{glyph(state)}</span>
          </li>
        );
      })}
      {tool ? <li className="px-1 font-mono text-[10.5px] text-ink-3">Tool · {tool}</li> : null}
    </ol>
  );
}

function glyph(state: AgentNodeState) {
  if (state === "completed") return "✓";
  if (state === "running") return "●";
  if (state === "failed") return "✕";
  return "○";
}

/**
 * Collapsed-by-default Agent execution card.
 * `open` follows the run automatically (live while executing, collapsed once
 * complete) and the user can always expand it again with [View].
 */
export function AgentActivityCard({
  execution,
  failed,
  className,
}: {
  execution: ExecutionState;
  failed?: boolean;
  className?: string;
}) {
  const running = execution.status === "running";
  const [open, setOpen] = useState(running);

  // Follow the run: expand while executing, collapse when it finishes.
  useEffect(() => {
    setOpen(execution.status === "running");
  }, [execution.status]);

  if (execution.status === "idle") return null;

  const done = execution.stage === "complete" || execution.status === "complete";
  const states = stageStates(execution.stage, failed);
  const completedCount = states.filter((state) => state === "completed").length;
  const summary = failed
    ? "Agent task stopped"
    : running
      ? `Agent working · ${completedCount}/${AGENT_STAGES.length}`
      : done
        ? "Agent task completed"
        : "Agent task";

  return (
    <section className={cn("sandbox-card mt-3 max-w-xl overflow-hidden rounded-xl border border-border bg-surface", className)} aria-label="Agent execution">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-2"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-ink-2" aria-hidden="true">
          <Bot size={14} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-ink">{summary}</span>
          <span className="block truncate text-[11px] text-ink-3">
            {running ? AGENT_STAGES.find((stage) => stage.id === execution.stage)?.label ?? "Processing request" : `${AGENT_STAGES.length} steps · tap to inspect`}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent">
          {open ? "Hide" : "View"}
          <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2.5">
          <p className="eyebrow mb-2">Agent execution</p>
          <AgentStageList stage={execution.stage} tool={execution.tool} failed={failed} />
          <PerformanceDisclosure execution={execution} className="border-border" />
        </div>
      ) : null}
    </section>
  );
}

function nodeClass(state: AgentNodeState) {
  if (state === "running") return "border-accent/40 bg-accent-soft text-ink";
  if (state === "completed") return "border-success/30 bg-success-soft text-ink-2";
  if (state === "failed") return "border-danger/40 bg-danger-soft text-danger";
  return "border-border bg-surface-2 text-ink-3";
}

function dotClass(state: AgentNodeState) {
  if (state === "running") return "bg-accent pulse-dot";
  if (state === "completed") return "bg-success";
  if (state === "failed") return "bg-danger";
  return "bg-ink-3/40";
}
