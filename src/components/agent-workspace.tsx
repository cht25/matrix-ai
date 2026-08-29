"use client";

// MATRIX Agent workspace — the side panel that opens after the Agent has
// generated project files. Rebuilt as a focused builder surface: identity
// header, model + file-count status, and the preview / files / publish /
// GitHub tabs provided by <ProjectWorkspace />.

import { useEffect, useState } from "react";
import { Code2, MonitorPlay, X } from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { ProjectWorkspace } from "@/components/projects/project-workspace";

export function AgentWorkspace({
  files,
  open,
  onClose,
  conversationId,
  projectId,
  model,
}: {
  files: AgentFile[];
  open: boolean;
  onClose: () => void;
  conversationId?: string | null;
  projectId?: string;
  model?: string | null;
}) {
  const [title, setTitle] = useState("Agent project");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <button type="button" className="fixed inset-0 z-[69] bg-black/45 backdrop-blur-sm" onClick={onClose} aria-label="Close Agent workspace" />
      <aside
        role="dialog"
        aria-modal="true"
        className="agent-sheet fixed inset-x-0 bottom-0 z-[70] flex h-[94dvh] w-full flex-col border-t border-border bg-bg shadow-[var(--shadow-pop)] sm:inset-y-0 sm:left-auto sm:right-0 sm:h-auto sm:w-[min(97vw,1040px)] sm:border-l sm:border-t-0"
        aria-label="Agent workspace"
      >
        <header className="agent-header flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="agent-logo grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white shadow-sm">
              <Code2 size={18} strokeWidth={1.9} />
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                <span className="truncate">{title}</span>
                <span className="hidden shrink-0 rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent sm:inline">
                  Agent
                </span>
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                <MonitorPlay size={11} />
                <span className="truncate">
                  {files.length} file{files.length === 1 ? "" : "s"} · live preview · public publish · GitHub
                </span>
                {model ? <span className="hidden truncate font-mono text-[10px] text-ink-3/80 md:inline">· {model}</span> : null}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Close Agent workspace">
            <X size={18} />
          </button>
        </header>

        <ProjectWorkspace projectId={projectId} initialFiles={files} conversationId={conversationId} onTitle={setTitle} />
      </aside>
    </>
  );
}
