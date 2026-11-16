"use client";

// =============================================================================
// Task outcome line — how a piece of Agent work ended.
//
// One state word, one sentence, and the facts behind it. Everything shown is
// derived from the stored run (lib/ai/task-outcome.ts); nothing here is taken
// from the model's own description of what it did.
// =============================================================================

import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, Hand, XCircle } from "lucide-react";
import type { TaskOutcome, TaskOutcomeState } from "@/lib/ai/task-outcome";
import { cn } from "@/lib/utils";

const TONE: Record<TaskOutcomeState, string> = {
  completed: "border-success/40 bg-success-soft text-success",
  failed: "border-danger/40 bg-danger-soft text-danger",
  blocked: "border-warning/40 bg-warning-soft text-warning",
  awaiting_approval: "border-accent/40 bg-accent-soft text-accent",
  awaiting_input: "border-accent/40 bg-accent-soft text-accent",
  paused: "border-warning/40 bg-warning-soft text-warning",
  cancelled: "border-border bg-surface-2 text-ink-2",
  running: "border-border bg-surface-2 text-ink-2",
};

const ICON: Record<TaskOutcomeState, typeof CheckCircle2> = {
  completed: CheckCircle2,
  failed: XCircle,
  blocked: AlertTriangle,
  awaiting_approval: Hand,
  awaiting_input: Hand,
  paused: Clock3,
  cancelled: CircleSlash,
  running: Clock3,
};

export function TaskOutcomeBadge({ outcome, className }: { outcome: Pick<TaskOutcome, "state" | "label">; className?: string }) {
  const Icon = ICON[outcome.state];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-5", TONE[outcome.state], className)}
      data-outcome={outcome.state}
    >
      <Icon size={12} aria-hidden="true" />
      {outcome.label}
    </span>
  );
}

/**
 * How a finished (or stopped) run ended: the state word, the facts behind it
 * and — unless the caller already says them — what happened and what to do
 * next.
 *
 * `detail={false}` is for a run shown under its own reply in the chat: the
 * reply is those sentences, so the line keeps to the state word and the facts.
 */
export function TaskOutcomeLine({ outcome, className, detail = true }: { outcome: TaskOutcome; className?: string; detail?: boolean }) {
  const showSummary = detail && (outcome.state !== "completed" || outcome.evidence.length === 0);
  const showNextStep = detail && Boolean(outcome.nextStep) && outcome.state !== "completed";
  // The error code is a fact too: it is what support or an administrator needs.
  const showCode = Boolean(outcome.code) && (outcome.state === "failed" || outcome.state === "blocked");
  return (
    <div className={cn("mt-1.5 max-w-xl text-[12px] leading-relaxed text-ink-2", className)} role="status" data-task-outcome={outcome.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <TaskOutcomeBadge outcome={outcome} />
        {outcome.evidence.map((fact) => (
          // Under a run card the address is already a link in the card itself.
          <span key={fact} className="min-w-0 break-words text-ink-3">{!detail && fact.startsWith("Published at ") ? "Published" : fact}</span>
        ))}
        {showCode ? <code className="min-w-0 break-all font-mono text-[10.5px] text-ink-3">{outcome.code}</code> : null}
      </div>
      {showSummary ? <p className="mt-1 text-ink-2">{outcome.summary}</p> : null}
      {showNextStep ? <p className="mt-0.5 text-ink-3">{outcome.nextStep}</p> : null}
    </div>
  );
}
