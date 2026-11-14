"use client";

// =============================================================================
// Arena-style compact live status & collapsible step timeline
//
// Always compact (one single sleek pill by default — never a giant expanded
// block). Every step rendered comes from real server execution events; private
// chain-of-thought text is never exposed. Clicking the pill expands or hides
// the step-by-step breakdown with real statuses and durations.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Loader2, XCircle } from "lucide-react";
import type { ChatMode } from "@/lib/ai/modes";
import type { WorkingStep } from "@/lib/chat-messages";
import { cn } from "@/lib/utils";
import { MATRIX_MODEL_LABEL, isMatrixModelId } from "@/lib/ai/model";

function useElapsed(active: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

/** High-level status copy per capability — safe to show, no private reasoning. */
export function statusCopy(mode: ChatMode, streamStatus?: string | null): string {
  if (streamStatus === "finalizing") return "Finalizing response…";
  if (streamStatus && streamStatus !== "connecting" && streamStatus !== "complete") return "Generating response…";
  switch (mode) {
    case "image": return "Generating image…";
    case "agent": return "Running agent task…";
    case "research": return "Synthesizing research…";
    case "code": return "Writing code…";
    case "study": return "Preparing study guide…";
    default: return "Working…";
  }
}

function StepTimeline({ steps }: { steps: WorkingStep[] }) {
  return (
    <ol className="mt-1.5 grid gap-1 rounded-lg border border-border/80 bg-surface-2/60 px-2.5 py-2">
      {steps.map((step) => (
        <li key={step.id} className="flex items-center gap-2 text-[11.5px] leading-snug">
          {step.status === "running" ? (
            <Loader2 size={11} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
          ) : step.status === "failed" ? (
            <XCircle size={11} className="shrink-0 text-danger" aria-hidden="true" />
          ) : (
            <Check size={11} className="shrink-0 text-success" aria-hidden="true" />
          )}
          <span className={cn("min-w-0 flex-1 truncate", step.status === "running" ? "font-medium text-ink" : "text-ink-2")}>
            {step.label}
            {step.detail ? <span className="ml-1.5 text-[10.5px] text-ink-3">· {step.detail}</span> : null}
          </span>
          {typeof step.durationMs === "number" && step.status !== "running" ? (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">
              {formatStepDuration(step.durationMs)}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function ResponseProgress({
  mode = "general",
  streamStatus,
  steps = [],
  provider,
  model,
  tier,
  className,
}: {
  mode?: ChatMode;
  streamStatus?: string | null;
  steps?: WorkingStep[];
  provider?: string | null;
  model?: string | null;
  tier?: "high" | "low" | null;
  className?: string;
}) {
  const elapsed = useElapsed(true);
  const [open, setOpen] = useState(false);

  const activeStep = [...steps].reverse().find((s) => s.status === "running") ?? steps[steps.length - 1];
  const label = activeStep ? activeStep.label : statusCopy(mode, streamStatus);
  const hasSteps = steps.length > 0;
  const badge = isMatrixModelId(model) ? MATRIX_MODEL_LABEL : provider || (tier ? MATRIX_MODEL_LABEL : null);

  return (
    <div className={cn("mb-2 max-w-xl", className)} role="status" aria-live="polite">
      <button
        type="button"
        disabled={!hasSteps}
        onClick={() => hasSteps && setOpen((v) => !v)}
        aria-expanded={hasSteps ? open : undefined}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface-2/80 px-2.5 py-1 text-left text-[12px] text-ink-2 transition-colors",
          hasSteps && "cursor-pointer hover:border-accent/40 hover:text-ink",
        )}
      >
        <Loader2 size={12} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-ink">{label}</span>
        {badge ? (
          <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] text-accent">
            {badge}
          </span>
        ) : null}
        {hasSteps ? (
          <span className="shrink-0 font-mono text-[10.5px] text-ink-3">
            {steps.length} {steps.length === 1 ? "step" : "steps"}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">
          {formatStepDuration(elapsed)}
        </span>
        {hasSteps ? (
          <ChevronRight
            size={12}
            className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {open && hasSteps ? <StepTimeline steps={steps} /> : null}
    </div>
  );
}

/**
 * Compact, collapsed-by-default Arena-style summary pill shown above an
 * assistant reply when real server execution steps were recorded.
 */
export function CompactStepsPill({
  steps,
  durationMs,
  provider,
  model,
  className,
}: {
  steps?: WorkingStep[] | null;
  durationMs?: number | null;
  provider?: string | null;
  model?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!steps || steps.length === 0) return null;

  const failed = steps.some((s) => s.status === "failed");
  const totalMs = typeof durationMs === "number" && durationMs > 0
    ? durationMs
    : steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);
  const badge = isMatrixModelId(model) ? MATRIX_MODEL_LABEL : provider || null;

  return (
    <div className={cn("mb-2 max-w-xl", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/80 bg-surface-2/60 px-2.5 py-0.5 text-left text-[11.5px] text-ink-3 transition-colors hover:border-border hover:bg-surface-2 hover:text-ink"
      >
        {failed ? (
          <XCircle size={11} className="shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <Check size={11} className="shrink-0 text-success" aria-hidden="true" />
        )}
        <span className="truncate font-medium text-ink-2">
          Worked · {steps.length} {steps.length === 1 ? "step" : "steps"}
        </span>
        {totalMs > 0 ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">
            · {formatStepDuration(totalMs)}
          </span>
        ) : null}
        {badge ? (
          <span className="shrink-0 rounded bg-surface px-1.5 py-px font-mono text-[9.5px] text-ink-3">
            {badge}
          </span>
        ) : null}
        <ChevronRight
          size={11}
          className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      {open ? <StepTimeline steps={steps} /> : null}
    </div>
  );
}
