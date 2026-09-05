"use client";

// =============================================================================
// Artifact surfaces (product spec §4–§8, §18)
//
// These render ONLY from an ArtifactState produced by lib/ai/artifacts, so an
// artifact literally cannot appear before it was requested:
//
//   Not Requested → Requested → Generating → Ready → Available
//
//   Export requested        [Generate PDF]
//   ✓ PDF ready             [Open] [Save]
//   JSON                    [Copy JSON] [Download JSON]
//   Image: Preparing… → Together AI → ✓ Image ready
// =============================================================================

import {
  Braces, Check, Copy, Download, ExternalLink, FileCode2, FileJson, FileSpreadsheet,
  FileText, FileType2, Image as ImageIcon, Loader2, RefreshCcw, SquarePen, Table2, X,
} from "lucide-react";
import type { ReactNode } from "react";
import { artifactStatusCopy, type ArtifactState } from "@/lib/ai/artifacts";
import type { ExportFormat } from "@/lib/ai/intent";
import { cn } from "@/lib/utils";

export const FORMAT_META: Record<ExportFormat, { label: string; icon: ReactNode; extension: string }> = {
  pdf: { label: "PDF", icon: <FileText size={13} strokeWidth={1.7} />, extension: "pdf" },
  docx: { label: "DOCX", icon: <FileType2 size={13} strokeWidth={1.7} />, extension: "docx" },
  markdown: { label: "Markdown", icon: <FileCode2 size={13} strokeWidth={1.7} />, extension: "md" },
  txt: { label: "TXT", icon: <Braces size={13} strokeWidth={1.7} />, extension: "txt" },
  json: { label: "JSON", icon: <FileJson size={13} strokeWidth={1.7} />, extension: "json" },
  csv: { label: "CSV", icon: <Table2 size={13} strokeWidth={1.7} />, extension: "csv" },
  xlsx: { label: "Excel", icon: <FileSpreadsheet size={13} strokeWidth={1.7} />, extension: "xlsx" },
};

const CARD = "mt-3 max-w-xl overflow-hidden rounded-xl border bg-surface";
const PRIMARY_BTN =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent";
const QUIET_BTN =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink";

function toneClasses(tone: "idle" | "active" | "success" | "danger") {
  if (tone === "success") return "border-success/35 bg-success-soft/40";
  if (tone === "danger") return "border-danger/40 bg-danger-soft";
  if (tone === "active") return "border-accent/35 bg-accent-soft/50";
  return "border-border bg-surface-2";
}

/**
 * One artifact, rendered per lifecycle step. `onGenerate` only exists while the
 * artifact is requested-but-not-built; ready artifacts expose Open/Save (and
 * Copy/Download for JSON, Save/Regenerate/Edit prompt for images).
 */
export function ArtifactCard({
  state,
  provider,
  canOpen,
  onGenerate,
  onOpen,
  onSave,
  onCopy,
  onRegenerate,
  onEditPrompt,
  onDismiss,
  note,
}: {
  state: ArtifactState;
  provider?: string | null;
  canOpen?: boolean;
  onGenerate?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onCopy?: () => void;
  onRegenerate?: () => void;
  onEditPrompt?: () => void;
  onDismiss?: () => void;
  note?: string | null;
}) {
  const copy = artifactStatusCopy(state);
  if (!copy) return null;
  const meta = state.format ? FORMAT_META[state.format] : null;
  const isImage = state.type === "IMAGE";
  const isJson = state.type === "JSON";
  const busy = state.status === "generating";
  // Image replies carry their actions in the response action row (Save ·
  // Regenerate · Edit prompt) so the card does not repeat them.
  const hasReadyActions = isImage
    ? Boolean(onSave || onRegenerate || onEditPrompt)
    : isJson
      ? Boolean(onCopy || onSave)
      : Boolean(onSave || (canOpen && onOpen));

  return (
    <section className={cn(CARD, toneClasses(copy.tone))} aria-label={`${state.label} artifact`} aria-busy={busy}>
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border bg-surface text-ink-2" aria-hidden="true">
          {busy ? <Loader2 size={14} className="animate-spin text-accent" /> : copy.tone === "success" ? <Check size={14} className="text-success" /> : isImage ? <ImageIcon size={14} /> : meta?.icon ?? <FileText size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-ink">{copy.title}</p>
          {copy.detail || note || provider ? (
            <p className="truncate text-[11px] text-ink-3">
              {isImage && busy ? "Preparing image… → Together AI" : copy.detail ?? note ?? provider ?? ""}
            </p>
          ) : null}
        </div>
        {onDismiss && state.status !== "generating" ? (
          <button type="button" onClick={onDismiss} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label={`Dismiss ${state.label}`}>
            <X size={13} />
          </button>
        ) : null}
      </header>

      {state.status === "requested" && onGenerate ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
          <button type="button" className={PRIMARY_BTN} onClick={onGenerate}>
            {isImage ? "Generate image" : `Generate ${state.label}`}
          </button>
          {provider ? <span className="font-mono text-[10px] text-ink-3">{provider}</span> : null}
        </div>
      ) : null}

      {state.status === "ready" && hasReadyActions ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
          {isImage ? (
            <>
              {onSave ? <button type="button" className={PRIMARY_BTN} onClick={onSave}><Download size={13} /> Save</button> : null}
              {onRegenerate ? <button type="button" className={QUIET_BTN} onClick={onRegenerate}><RefreshCcw size={13} /> Regenerate</button> : null}
              {onEditPrompt ? <button type="button" className={QUIET_BTN} onClick={onEditPrompt}><SquarePen size={13} /> Edit prompt</button> : null}
            </>
          ) : isJson ? (
            <>
              {onCopy ? <button type="button" className={PRIMARY_BTN} onClick={onCopy}><Copy size={13} /> Copy JSON</button> : null}
              {onSave ? <button type="button" className={QUIET_BTN} onClick={onSave}><Download size={13} /> Download JSON</button> : null}
            </>
          ) : (
            <>
              {canOpen && onOpen ? <button type="button" className={PRIMARY_BTN} onClick={onOpen}><ExternalLink size={13} /> Open</button> : null}
              {onSave ? <button type="button" className={cn(canOpen && onOpen ? QUIET_BTN : PRIMARY_BTN)} onClick={onSave}><Download size={13} /> Save</button> : null}
            </>
          )}
          {state.filename ? <span className="ml-auto truncate font-mono text-[10px] text-ink-3">{state.filename}</span> : null}
        </div>
      ) : null}

      {state.status === "failed" ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
          {onGenerate ? <button type="button" className={PRIMARY_BTN} onClick={onGenerate}><RefreshCcw size={13} /> Try again</button> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * §20 — "Make a report." never auto-builds PDF + DOCX + TXT + JSON. Matrix
 * answers normally and offers a minimal format choice.
 */
export function FormatChoice({ formats, onPick }: { formats: ExportFormat[]; onPick: (format: ExportFormat) => void }) {
  if (!formats.length) return null;
  return (
    <div className="mt-3 flex max-w-xl flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface-2 px-3 py-2">
      <p className="mr-1 text-[12px] text-ink-2">What format would you like?</p>
      {formats.map((format) => (
        <button key={format} type="button" className={PRIMARY_BTN} onClick={() => onPick(format)}>
          {FORMAT_META[format].icon}
          {FORMAT_META[format].label}
        </button>
      ))}
    </div>
  );
}

/** Inline "Export as" row used inside the More menu flow on small screens. */
export function ExportFormatRow({ formats, onPick, onClose }: { formats: ExportFormat[]; onPick: (format: ExportFormat) => void; onClose: () => void }) {
  if (!formats.length) return null;
  return (
    <div className="mt-2 flex max-w-xl flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface-2 px-3 py-2">
      <p className="eyebrow mr-1">Export as</p>
      {formats.map((format) => (
        <button key={format} type="button" className={PRIMARY_BTN} onClick={() => onPick(format)}>
          {FORMAT_META[format].icon}
          {FORMAT_META[format].label}
        </button>
      ))}
      <button type="button" className={cn(QUIET_BTN, "ml-auto")} onClick={onClose} aria-label="Close export options">
        <X size={13} />
      </button>
    </div>
  );
}
