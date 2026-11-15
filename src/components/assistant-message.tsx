"use client";

// =============================================================================
// One assistant reply (product spec §17, §23, §25)
//
//   Response
//   ├── Content                     ← always the most important element
//   └── Contextual actions          ← only what is valid for THIS reply
//
// Everything else (artifact card, format choice, flashcards, agent execution,
// activity, export picker) is rendered conditionally from real state — nothing
// here is painted and then hidden with CSS.
// =============================================================================

import { memo, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, MonitorPlay, RotateCcw } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { ResponseActions, type ChatAction } from "@/components/response-actions";
import { ArtifactCard, ExportFormatRow, FormatChoice } from "@/components/artifact-panel";
import { ActivityDisclosure } from "@/components/activity-panel";
import { CompactStepsPill } from "@/components/response-status";
import { FlashcardDeck } from "@/components/mode-workspace";
import { BuildRunCard } from "@/components/build/build-run-card";
import type { BuildRun } from "@/lib/deploy/stages";
import { ThemeGallery } from "@/components/theme-gallery";
import { isArtifactVisible, type ArtifactState, type ExecutionState } from "@/lib/ai/artifacts";
import type { ContentSignals, ExportFormat, IntentResult, ResponseKind } from "@/lib/ai/intent";
import { replyVersions, type ChatMessage } from "@/lib/chat-messages";

export type AssistantMessageProps = {
  message: ChatMessage;
  isLatest: boolean;
  streaming: boolean;
  kind: ResponseKind;
  signals: ContentSignals;
  intent: IntentResult;
  artifact: ArtifactState;
  /** Execution detail for the latest turn only — null keeps the UI clean. */
  execution: ExecutionState | null;
  /** Live pipeline state for the turn currently streaming, if any. */
  liveBuildRun?: BuildRun | null;
  onRetryBuild?: () => void;
  timeLabel: string;
  actions: { primary: ChatAction[]; overflow: ChatAction[] };
  /** Formats this reply can honestly be exported to. */
  exportFormats: ExportFormat[];
  exportPickerOpen: boolean;
  onCloseExportPicker: () => void;
  onPickFormat: (format: ExportFormat) => void;
  onGenerateArtifact: () => void;
  onDismissArtifact: () => void;
  onOpenArtifact: () => void;
  onSaveArtifact: () => void;
  onCopyArtifact: () => void;
  onOpenWorkspace: () => void;
  artifactActions: { canOpen: boolean; provider: string | null };
  /** Re-ask for a reply that stopped early. Only offered on the latest turn. */
  onRetryInterrupted?: () => void;
  /** Copy the answer that is currently displayed (it may be an earlier version). */
  onCopyVersion?: (text: string) => void;
};

/**
 * ‹ 2 / 3 › — the answers a regenerated reply has had. Nothing is lost when
 * Regenerate replaces an answer: earlier ones stay one tap away.
 */
function VersionSwitcher({ index, total, onChange }: { index: number; total: number; onChange: (next: number) => void }) {
  return (
    <span className="inline-flex items-center text-ink-3" role="group" aria-label="Answer versions">
      <button type="button" onClick={() => onChange(index - 1)} disabled={index <= 0} aria-label="Show the earlier answer" title="Earlier answer" className="msg-action !px-0">
        <ChevronLeft size={15} aria-hidden="true" />
      </button>
      <span className="min-w-9 text-center font-mono text-[11px] tabular-nums text-ink-2" aria-live="polite" aria-label={`Answer ${index + 1} of ${total}`}>
        {index + 1} / {total}
      </span>
      <button type="button" onClick={() => onChange(index + 1)} disabled={index >= total - 1} aria-label="Show the later answer" title="Later answer" className="msg-action !px-0">
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </span>
  );
}

export const AssistantMessage = memo(function AssistantMessage(props: AssistantMessageProps) {
  const {
    message, isLatest, streaming, kind, signals, intent, artifact, execution, liveBuildRun, onRetryBuild, timeLabel, actions,
    exportFormats, exportPickerOpen, onCloseExportPicker, onPickFormat,
    onGenerateArtifact, onDismissArtifact, onOpenArtifact, onSaveArtifact, onCopyArtifact,
    onOpenWorkspace, artifactActions, onRetryInterrupted, onCopyVersion,
  } = props;

  const versions = replyVersions(message);
  const total = versions.length;
  // null = the current answer. A new answer always returns the view to it.
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => { setPicked(null); }, [total, message.content]);
  const shown = picked === null ? total - 1 : Math.max(0, Math.min(total - 1, picked));
  const viewingEarlier = shown < total - 1;
  const text = viewingEarlier ? versions[shown].content : message.content;

  const files = message.metadata?.artifacts ?? [];
  const showArtifact = isArtifactVisible(artifact);
  // A format choice is offered only for an ambiguous document request that has
  // not already produced an artifact.
  const showFormatChoice = isLatest && !streaming && intent.needsFormatChoice && !intent.suppressExport && !showArtifact;
  const showExecution = isLatest && !streaming && execution !== null && execution.status !== "idle";

  return (
    <div className="min-w-0">
      {message.metadata?.steps?.length && !viewingEarlier ? (
        <CompactStepsPill
          steps={message.metadata.steps}
          durationMs={message.metadata.duration_ms}
          provider={message.metadata.provider}
          model={message.metadata.model}
        />
      ) : null}
      {viewingEarlier ? (
        <p className="mb-2 inline-flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2">
          Earlier answer
          <button type="button" onClick={() => setPicked(null)} className="font-medium text-accent hover:underline">Show current</button>
        </p>
      ) : null}
      <Markdown text={text} />

      {message.metadata?.interrupted && !viewingEarlier ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3" role="status">
          This answer stopped early.
          {isLatest && onRetryInterrupted ? (
            <button type="button" onClick={onRetryInterrupted} disabled={streaming} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 font-medium text-ink hover:bg-surface-2 disabled:opacity-50">
              <RotateCcw size={13} aria-hidden="true" /> Try again
            </button>
          ) : null}
        </p>
      ) : null}

      {viewingEarlier ? null : (<>
      {message.metadata?.image_data_url ? (
        // Generated image. `w-full` + `object-contain` keeps it inside the
        // viewport on mobile — it can never overflow horizontally.
        <figure className="mt-3 overflow-hidden rounded-[12px] border border-border">
          <figcaption className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
            <span className="eyebrow">Image</span>
            <span className="mono text-[10px] text-ink-3">
              {String(message.metadata.provider ?? "")} {String(message.metadata.model ?? "")}
            </span>
          </figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={message.metadata.image_data_url}
            alt="Generated image"
            loading="lazy"
            decoding="async"
            className="max-h-[70svh] w-full bg-surface-3 object-contain"
          />
        </figure>
      ) : null}

      {showArtifact ? (
        <ArtifactCard
          state={artifact}
          provider={artifactActions.provider}
          canOpen={artifactActions.canOpen}
          onGenerate={artifact.status === "requested" || artifact.status === "failed" ? onGenerateArtifact : undefined}
          onOpen={artifact.status === "ready" && artifactActions.canOpen ? onOpenArtifact : undefined}
          // Image replies carry Save / Regenerate / Edit prompt in the action
          // row below, so the card never repeats them.
          onSave={artifact.status === "ready" && artifact.type !== "IMAGE" ? onSaveArtifact : undefined}
          onCopy={artifact.status === "ready" && artifact.type === "JSON" ? onCopyArtifact : undefined}
          onDismiss={onDismissArtifact}
        />
      ) : null}

      {showFormatChoice ? <FormatChoice formats={intent.formatChoices} onPick={onPickFormat} /> : null}

      {isLatest && !streaming && signals.hasFlashcards ? <FlashcardDeck text={message.content} /> : null}

      {message.metadata?.build || liveBuildRun ? (
        <BuildRunCard
          snapshot={message.metadata?.build ?? null}
          deployment={message.metadata?.deployment ?? null}
          liveRun={liveBuildRun}
          onOpenWorkspace={files.length || message.metadata?.project_id ? onOpenWorkspace : undefined}
          onRetry={onRetryBuild}
        />
      ) : null}

      {files.length ? (
        <button
          type="button"
          onClick={onOpenWorkspace}
          className="mt-3 flex w-full max-w-xl items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-left transition-colors hover:border-accent/60"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-white" aria-hidden="true">
              <MonitorPlay size={15} />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-semibold text-ink">Open Agent workspace</span>
              <span className="block truncate text-[11px] text-ink-3">
                {files.length} file{files.length === 1 ? "" : "s"} · live preview · GitHub push
              </span>
            </span>
          </span>
          <span className="shrink-0 text-[11.5px] font-medium text-accent">Review</span>
        </button>
      ) : null}

      {message.metadata?.action === "theme_gallery" ? (
        <div className="mt-3 max-w-xl rounded-xl border border-border bg-surface p-3">
          <ThemeGallery compact />
        </div>
      ) : null}

      {showExecution && execution ? (
        kind === "agent" ? null : <ActivityDisclosure execution={execution} />
      ) : null}

      {exportPickerOpen && exportFormats.length ? (
        <ExportFormatRow formats={exportFormats} onPick={onPickFormat} onClose={onCloseExportPicker} />
      ) : null}
      </>)}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {total > 1 ? <VersionSwitcher index={shown} total={total} onChange={(next) => setPicked(next >= total - 1 ? null : Math.max(0, next))} /> : null}
        {viewingEarlier ? (
          <button type="button" onClick={() => onCopyVersion?.(text)} className="msg-action">Copy this version</button>
        ) : (
          <ResponseActions primary={actions.primary} overflow={actions.overflow} quiet={!isLatest} menuLabel="More response actions" />
        )}
        {timeLabel ? <span className="px-1 font-mono text-[10.5px] text-ink-3">{timeLabel}</span> : null}
      </div>
    </div>
  );
});
