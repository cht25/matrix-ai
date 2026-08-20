"use client";

import { Code2, X } from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { ProjectWorkspace } from "@/components/projects/project-workspace";

export function AgentWorkspace({
  files,
  open,
  onClose,
  conversationId,
  projectId,
}: {
  files: AgentFile[];
  open: boolean;
  onClose: () => void;
  conversationId?: string | null;
  projectId?: string;
}) {
  if (!open) return null;

  return (
    <>
      <button type="button" className="fixed inset-0 z-[69] bg-black/45 backdrop-blur-sm" onClick={onClose} aria-label="Close Agent workspace" />
      <aside className="fixed inset-x-0 bottom-0 z-[70] flex h-[92dvh] w-full flex-col border-t border-border bg-bg shadow-[var(--shadow-pop)] sm:inset-y-0 sm:left-auto sm:right-0 sm:h-auto sm:w-[min(96vw,980px)] sm:border-l sm:border-t-0" aria-label="Agent workspace">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-white"><Code2 size={16} /></span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">Agent workspace</p>
              <p className="text-[11px] text-ink-3">{files.length} generated file{files.length === 1 ? "" : "s"} · folders · preview · publish</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Close Agent workspace"><X size={17} /></button>
        </header>
        <ProjectWorkspace projectId={projectId} initialFiles={files} conversationId={conversationId} />
      </aside>
    </>
  );
}
