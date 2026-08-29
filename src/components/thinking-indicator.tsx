"use client";

// A collapsible "thinking" indicator shown while the model is working, and —
// once the answer arrives — collapsed into a quiet dropdown chip (like other
// AI web UIs). While processing it is expanded with animated status; the
// animated indicator disappears when output is generated and only the
// collapsed "Reasoning / thinking" dropdown remains (hidden by default until
// the user expands it).

import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Stage = { label: string; ms: number };

const AGENT_STAGES: Stage[] = [
  { label: "Understanding your request", ms: 900 },
  { label: "Planning the project", ms: 2400 },
  { label: "Writing code and files", ms: 5200 },
  { label: "Checking everything works", ms: 8200 },
];

const CHAT_STAGES: Stage[] = [
  { label: "Reading your message", ms: 700 },
  { label: "Thinking it through", ms: 2200 },
  { label: "Writing the answer", ms: 4600 },
];

function useElapsed(active: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);
  useEffect(() => {
    if (!active) return;
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 250);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stageIndex(stages: Stage[], elapsed: number): number {
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    if (elapsed >= stages[i].ms) return i;
  }
  return 0;
}

/**
 * Live indicator rendered while the request is in flight.
 */
export function ThinkingIndicator({
  mode = "general",
  model,
}: {
  mode?: "general" | "agent";
  model?: string | null;
}) {
  const stages = mode === "agent" ? AGENT_STAGES : CHAT_STAGES;
  const elapsed = useElapsed(true);
  const current = stageIndex(stages, elapsed);
  const [open, setOpen] = useState(true);

  return (
    <div className={cn("thinking-block thinking-live", !open && "thinking-live-collapsed")} role="status" aria-label={mode === "agent" ? "Agent is working" : "MATRIX is thinking"}>
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BrainCircuit size={14} strokeWidth={1.8} className="thinking-spin text-accent" aria-hidden="true" />
        <span className="thinking-title">{mode === "agent" ? "Agent is working…" : "Thinking…"}</span>
        {open ? (
          <span className="thinking-dots" aria-hidden="true">
            <span className="typing-dot h-1 w-1 rounded-full bg-accent" />
            <span className="typing-dot h-1 w-1 rounded-full bg-accent" />
            <span className="typing-dot h-1 w-1 rounded-full bg-accent" />
          </span>
        ) : null}
        <span className="thinking-elapsed">{formatDuration(elapsed)}</span>
        <ChevronDown size={13} className={cn("thinking-chevron", open && "thinking-chevron-open")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="thinking-body thinking-body-open">
          <ul className="thinking-stages">
            {stages.map((stage, i) => {
              const done = i < current;
              const active = i === current;
              return (
                <li key={stage.label} className={cn("thinking-stage", done && "is-done", active && "is-active")}>
                  <span className="thinking-mark" aria-hidden="true">
                    {done ? <Check size={11} /> : <span className="thinking-pulse" />}
                  </span>
                  <span className="thinking-stage-label">{stage.label}</span>
                </li>
              );
            })}
          </ul>
          {model ? <p className="thinking-model">{model}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Collapsed-by-default dropdown attached to a finished assistant message.
 * The animated indicator is gone; this quiet chip only expands on click.
 */
export function ThinkingSummary({
  durationMs,
  mode = "general",
  model,
}: {
  durationMs: number;
  mode?: "general" | "agent";
  model?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("thinking-block thinking-done", open && "thinking-done-open")}>
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BrainCircuit size={13} strokeWidth={1.8} className="text-ink-3" aria-hidden="true" />
        <span className="thinking-title">{mode === "agent" ? "Agent reasoning" : "Thought for"} {formatDuration(durationMs)}</span>
        <ChevronDown size={13} className={cn("thinking-chevron", open && "thinking-chevron-open")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="thinking-body thinking-body-open">
          <p className="thinking-note">
            {mode === "agent"
              ? "The Agent read your request, planned the change and generated the complete project files. Review them in the workspace before previewing or publishing."
              : "MATRIX processed your request and composed this answer."}
          </p>
          {model ? <p className="thinking-model">{model}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
