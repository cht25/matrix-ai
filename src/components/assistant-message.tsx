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

import { MonitorPlay } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { ResponseActions, type ChatAction } from "@/components/response-actions";
import { ArtifactCard, ExportFormatRow, FormatChoice } from "@/components/artifact-panel";
import { ActivityDisclosure } from "@/components/activity-panel";
import { AgentActivityCard } from "@/components/agent-sandbox";
import { FlashcardDeck } from "@/components/mode-workspace";
import { BuildRunCard } from "@/components/build/build-run-card";
import type { BuildRun } from "@/lib/deploy/stages";
import { ThemeGallery } from "@/components/theme-gallery";
import { isArtifactVisible, type ArtifactState, type ExecutionState } from "@/lib/ai/artifacts";
import type { ContentSignals, ExportFormat, IntentResult, ResponseKind } from "@/lib/ai/intent";
import type { ChatMessage } from "@/lib/chat-messages";

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
};

export function AssistantMessage(props: AssistantMessageProps) {
  const {
    message, isLatest, streaming, kind, signals, intent, artifact, execution, liveBuildRun, onRetryBuild, timeLabel, actions,
    exportFormats, exportPickerOpen, onCloseExportPicker, onPickFormat,
    onGenerateArtifact, onDismissArtifact, onOpenArtifact, onSaveArtifact, onCopyArtifact,
    onOpenWorkspace, artifactActions,
  } = props;

  const files = message.metadata?.artifacts ?? [];
  const showArtifact = isArtifactVisible(artifact);
  // A format choice is offered only for an ambiguous document request that has
  // not already produced an artifact.
  const showFormatChoice = isLatest && !streaming && intent.needsFormatChoice && !intent.suppressExport && !showArtifact;
  const showExecution = isLatest && !streaming && execution !== null && execution.status !== "idle";

  return (
    <div className="border-l border-border pl-4">
      <Markdown text={message.content} />

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
        kind === "agent" ? <AgentActivityCard execution={execution} failed={execution.status === "failed"} /> : <ActivityDisclosure execution={execution} />
      ) : null}

      {exportPickerOpen && exportFormats.length ? (
        <ExportFormatRow formats={exportFormats} onPick={onPickFormat} onClose={onCloseExportPicker} />
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {timeLabel ? <span className="px-0.5 font-mono text-[10px] text-ink-3">{timeLabel}</span> : null}
        <ResponseActions primary={actions.primary} overflow={actions.overflow} />
      </div>

    </div>
  );
}
