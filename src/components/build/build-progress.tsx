"use client";

// =============================================================================
// Live build status (§3, §13, §14, §21)
//
//   ┌──────────────────────────────┐
//   │ MATRIX BUILD                 │
//   │ ✓ Planning                   │
//   │ ● Building                   │
//   │ 3 / 6 steps                  │
//   └──────────────────────────────┘
//
// Everything rendered here comes from a BuildRun the server produced. No
// timers, no simulated progress: when the run says "validating", we paint
// "validating".
// =============================================================================

import { useState } from "react";
import { Activity, ChevronDown, FileDiff, Terminal } from "lucide-react";
import type { BuildCheck } from "@/lib/deploy/validate";
import type { BuildRun, BuildStageId, FileChange, StageState } from "@/lib/deploy/stages";
import { changeCounts, stageDef, stageProgress } from "@/lib/deploy/stages";
import { relativeTime, timeOfDay } from "@/lib/deploy/format";
import { cn } from "@/lib/utils";
import { Progress, Spinner } from "@/components/ui";

const GLYPH: Record<StageState, string> = {
  queued: "○",
  running: "●",
  completed: "✓",
  failed: "✕",
  skipped: "—",
};

export function stageGlyph(state: StageState): string {
  return GLYPH[state] ?? GLYPH.queued;
}

function stateClass(state: StageState): string {
  if (state === "completed") return "border-success/30 bg-success-soft text-ink-2";
  if (state === "running") return "border-accent/45 bg-accent-soft text-ink";
  if (state === "failed") return "border-danger/45 bg-danger-soft text-danger";
  if (state === "skipped") return "border-border bg-surface-2 text-ink-3";
  return "border-border bg-surface-2 text-ink-3";
}

export function BuildStatusCard({
  run,
  className,
  showLogs = true,
}: {
  run: BuildRun | null;
  className?: string;
  showLogs?: boolean;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  if (!run) return null;
  const progress = stageProgress(run);
  const live = run.status === "running" || run.status === "requested";
  return (
    <section
      className={cn("sandbox-card mt-3 max-w-xl overflow-hidden rounded-xl border border-border bg-surface", className)}
      aria-label="Matrix build status"
      aria-live="polite"
    >
      <header className="flex items-center gap-2.5 border-b border-border px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent-soft text-accent" aria-hidden="true">
          {live ? <Spinner className="h-3.5 w-3.5" /> : <Activity size={13} strokeWidth={2} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-ink-3">Matrix build</p>
          <p className="truncate text-[12.5px] font-semibold text-ink">
            {run.status === "succeeded"
              ? run.actions.publish
                ? "Build and publish finished"
                : "Build finished"
              : run.status === "failed"
                ? "Build stopped"
                : `BUILDING PROJECT · ${progress.activeLabel}`}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-3">
          {progress.completed} / {progress.total} steps
        </span>
      </header>

      <div className="px-3 py-2.5">
        <Progress value={progress.percent} className="mb-2.5" />
        <ol className="grid gap-1.5">
          {run.stages.map((stage) => (
            <li key={stage.id} className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]", stateClass(stage.state))}>
              <span className={cn("mt-px shrink-0 font-mono text-[13px] leading-none", stage.state === "running" && "pulse-dot text-accent")} aria-hidden="true">
                {stageGlyph(stage.state)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{stageDef(stage.id).label}</span>
                {stage.message ? <span className="mt-0.5 block break-words text-[11px] leading-snug text-ink-3">{stage.message}</span> : null}
              </span>
              {stage.state === "running" && stage.startedAt ? (
                <span className="shrink-0 font-mono text-[10px] text-ink-3">{relativeTime(stage.startedAt)}</span>
              ) : null}
            </li>
          ))}
        </ol>

        {run.attempts > 0 ? (
          <p className="mt-2 text-[11.5px] text-ink-2">
            Auto-fix: {run.attempts} repair attempt{run.attempts === 1 ? "" : "s"} of {run.maxAttempts} · each one rebuilt and revalidated the project.
          </p>
        ) : null}

        {run.error ? (
          <p className="mt-2 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-2 text-[11.5px] leading-snug text-danger">
            {run.error.message}
            <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wide text-danger/80">{run.error.code}</span>
          </p>
        ) : null}

        {run.changes.length ? <ChangeSummary changes={run.changes} className="mt-2.5" /> : null}
        {run.validation?.length ? <BuildChecks checks={run.validation} compact /> : null}

        {showLogs && run.logs.length ? (
          <div className="mt-2.5">
            <button
              type="button"
              onClick={() => setLogsOpen((value) => !value)}
              className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2 hover:text-ink"
              aria-expanded={logsOpen}
            >
              <Terminal size={12} /> Build logs ({run.logs.length})
              <ChevronDown size={12} className={cn("transition-transform", logsOpen && "rotate-180")} />
            </button>
            {logsOpen ? <LogList lines={run.logs.map((line) => ({ at: String(line.at), step: line.stage ?? "info", detail: line.message }))} /> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// §14 Build validation
// ---------------------------------------------------------------------------

export function BuildChecks({
  checks,
  compact = false,
  onFix,
  onViewError,
  fixDisabled,
}: {
  checks: BuildCheck[] | null | undefined;
  compact?: boolean;
  onFix?: () => void;
  onViewError?: () => void;
  fixDisabled?: boolean;
}) {
  if (!checks || !checks.length) return null;
  const failed = checks.filter((check) => check.status === "failed");
  return (
    <div className={cn("rounded-xl border border-border bg-surface-2/60 p-3", compact ? "mt-2.5" : "mt-3")}>
      <p className="eyebrow mb-2 text-ink-3">{failed.length ? "Build failed checks" : "Build check"}</p>
      <ul className="grid gap-1.5">
        {checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2 text-[12px]">
            <span
              className={cn(
                "mt-px shrink-0 font-mono",
                check.status === "passed" ? "text-success" : check.status === "failed" ? "text-danger" : "text-ink-3",
              )}
              aria-hidden="true"
            >
              {check.status === "passed" ? "✓" : check.status === "failed" ? "✕" : "—"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-ink">{check.label}</span>
              {check.message ? <span className="ml-1.5 text-ink-3">{check.message}</span> : null}
              {!compact && check.issues.length ? (
                <ul className="mt-1 grid gap-1">
                  {check.issues.slice(0, 6).map((issue, index) => (
                    <li key={index} className={cn("text-[11.5px] leading-snug", issue.severity === "error" ? "text-danger" : "text-warning")}>
                      <span className="font-mono text-[10.5px]">
                        {issue.path}
                        {issue.line ? `:${issue.line}` : ""}
                      </span>{" "}
                      {issue.message}
                    </li>
                  ))}
                  {check.issues.length > 6 ? <li className="text-[11px] text-ink-3">+{check.issues.length - 6} more</li> : null}
                </ul>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {failed.length && (onFix || onViewError) ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {onFix ? (
            <button
              type="button"
              onClick={onFix}
              disabled={fixDisabled}
              className="inline-flex min-h-8 items-center rounded-lg bg-accent px-2.5 text-[11.5px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              Fix automatically
            </button>
          ) : null}
          {onViewError ? (
            <button type="button" onClick={onViewError} className="inline-flex min-h-8 items-center rounded-lg border border-border px-2.5 text-[11.5px] font-medium text-ink-2 hover:text-ink">
              View error
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §13 File change summary
// ---------------------------------------------------------------------------

export function ChangeSummary({ changes, className, defaultOpen = false }: { changes: FileChange[]; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const counts = changeCounts(changes);
  const groups: Array<{ label: string; kind: FileChange["kind"] }> = [
    { label: "Created", kind: "created" },
    { label: "Modified", kind: "modified" },
    { label: "Removed", kind: "removed" },
  ];
  return (
    <div className={cn("rounded-xl border border-border bg-surface-2/60", className)}>
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={open}>
        <FileDiff size={12} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">
          {counts.created ? <span className="text-success">+ {counts.created} created </span> : null}
          {counts.modified ? <span className="text-accent">~ {counts.modified} modified </span> : null}
          {counts.removed ? <span className="text-danger">- {counts.removed} removed</span> : null}
        </span>
        <span className="shrink-0 text-[11px] font-medium text-accent">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="grid gap-2 border-t border-border px-3 py-2 sm:grid-cols-3">
          {groups.map((group) => {
            const paths = changes.filter((change) => change.kind === group.kind).map((change) => change.path);
            if (!paths.length) return null;
            return (
              <div key={group.kind}>
                <p className="eyebrow text-ink-3">{group.label}</p>
                <ul className="mt-1 grid gap-0.5">
                  {paths.slice(0, 20).map((path) => (
                    <li key={path} className="truncate font-mono text-[11px] text-ink-2">
                      {path}
                    </li>
                  ))}
                  {paths.length > 20 ? <li className="text-[10.5px] text-ink-3">+{paths.length - 20} more</li> : null}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §21 Deployment / build logs
// ---------------------------------------------------------------------------

export type LogRow = { at: string; step: string; detail: string };

export function LogList({ lines, maxHeight = 200 }: { lines: LogRow[]; maxHeight?: number }) {
  if (!lines.length) return <p className="py-2 text-[11.5px] text-ink-3">No log lines yet.</p>;
  return (
    <ol className="mt-1 overflow-y-auto rounded-lg border border-border bg-bg/80 p-2 font-mono text-[11px] leading-relaxed text-ink-2" style={{ maxHeight }}>
      {lines.map((line, index) => (
        <li key={index} className="flex gap-2">
          <span className="shrink-0 text-ink-3">{line.at.includes("T") ? timeOfDay(line.at) : line.at}</span>
          <span className="min-w-0 flex-1 break-words">
            <span className="text-accent">{line.step}</span> {line.detail}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function DeploymentLogsDisclosure({ lines, label = "Deployment logs" }: { lines: LogRow[]; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-surface">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={open}>
        <Terminal size={12} className="text-ink-3" />
        <span className="min-w-0 flex-1 text-[12px] font-medium text-ink">{label}</span>
        <span className="shrink-0 text-[11px] font-medium text-accent">{open ? "Hide ▴" : "Show ▾"}</span>
      </button>
      {open ? (
        <div className="border-t border-border px-3 pb-3">
          <LogList lines={lines} />
        </div>
      ) : null}
    </div>
  );
}

/** Stage label used in status rows and the composer hint. */
export function activeStageLabel(run: BuildRun | null): string {
  if (!run) return "";
  const active = run.stages.find((stage) => stage.state === "running");
  return active ? stageDef(active.id as BuildStageId).label : stageProgress(run).activeLabel;
}
