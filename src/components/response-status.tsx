"use client";

// =============================================================================
// Live response status (product spec §12)
//
// The old "Thinking…" block staged a fake chain-of-thought ("Reading your
// message", "Thinking it through"…) and stayed attached to finished answers.
// Reasoning is private: while a request is in flight Matrix now shows one quiet
// status line — "Generating response…" — plus elapsed time. Everything else is
// opt-in through the Activity disclosure.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ChatMode } from "@/lib/ai/modes";
import { cn } from "@/lib/utils";

function useElapsed(active: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 500);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** High-level status copy per capability — safe to show, no reasoning. */
export function statusCopy(mode: ChatMode, streamStatus?: string | null): string {
  if (streamStatus && streamStatus !== "connecting" && streamStatus !== "complete") return "Generating response…";
  switch (mode) {
    case "image": return "Generating image…";
    case "agent": return "Running agent task…";
    case "research": return "Preparing research answer…";
    case "code": return "Writing code…";
    case "study": return "Preparing your lesson…";
    default: return "Generating response…";
  }
}

export function ResponseProgress({
  mode = "general",
  streamStatus,
  className,
}: {
  mode?: ChatMode;
  streamStatus?: string | null;
  className?: string;
}) {
  const elapsed = useElapsed(true);
  return (
    <p
      className={cn("flex items-center gap-2 py-1 text-[12.5px] text-ink-2", className)}
      role="status"
      aria-live="polite"
    >
      <Loader2 size={13} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{statusCopy(mode, streamStatus)}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-ink-3 tabular-nums">{formatDuration(elapsed)}</span>
    </p>
  );
}
