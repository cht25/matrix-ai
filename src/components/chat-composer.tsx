"use client";

// =============================================================================
// The MATRIX composer — one implementation for Chat and Agent.
//
// What the primary button is depends on what the user has prepared:
//
//   nothing typed, nothing attached   →  [🎤]            mic only, no Send
//   text typed                        →  [➤]             Send; mic steps aside
//   one or more attachments           →  [🎤] [➤]        Send plus a separate Voice
//   a request is running              →  [■]             Stop generating
//   recording                         →  the recording panel replaces the field
//
// Enter sends and Shift+Enter adds a line on a hardware keyboard. On a touch
// keyboard Enter adds a line (there is no Shift+Enter there) and the Send
// button sends. A composing IME (Bangla, Japanese, …) is never interrupted.
//
// Presentation + local UI state only: sending, attachments and voice are
// owned by ChatClient, which keeps unsent text and files if a send fails.
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowUp, Code2, FileCode2, FileText, Globe, Loader2, Mic, Paperclip, Plus, Square, X } from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { VoiceRecordingPanel, VoiceTranscribing } from "@/components/voice-composer";
import type { RecorderState } from "@/lib/client/use-voice-recorder";
import { cn } from "@/lib/utils";

export type ComposerAttachment = { name: string; size: number; type?: string };

export const ATTACHMENT_ACCEPT =
  ".txt,.md,.mdx,.json,.jsonc,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.html,.htm,.css,.scss,.sass,.less,.vue,.svelte,.sql,.graphql,.yaml,.yml,.toml,.xml,.env,.sh,.bash,.go,.rs,.java,.kt,.php,.rb,.swift,.dart,.c,.h,.cc,.cpp,.cs,.csv,.log,Dockerfile,Makefile,image/png,image/jpeg,image/webp";

const ROUND = "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(1, bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(name: string): ReactNode {
  return /\.(md|mdx|txt|log|csv)$/i.test(name) ? <FileText size={14} aria-hidden="true" /> : <FileCode2 size={14} aria-hidden="true" />;
}

export function ChatComposer(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  sendLabel: string;

  attachments: ComposerAttachment[];
  onRemoveAttachment: (name: string) => void;
  image?: { name: string; previewUrl: string; size: number } | null;
  uploadingImage?: boolean;
  onRemoveImage?: () => void;
  onFiles: (files: File[]) => void;

  /** A request is in flight: the primary button becomes Stop. */
  busy: boolean;
  onSend: () => void;
  onStop: () => void;

  recorderState: RecorderState;
  recorderElapsedMs: number;
  recorderHasWaveform: boolean;
  recorderCanvasRef: RefObject<HTMLCanvasElement | null>;
  voiceLanguage: string;
  onVoiceLanguage: (code: string) => void;
  onStartVoice: () => void;
  onCancelVoice: () => void;
  onPauseVoice: () => void;
  onStopVoice: () => void;
  onTranscribeVoice: () => void;
  transcribing: boolean;
  onCancelTranscribe: () => void;

  webSearch: boolean;
  onToggleWebSearch: () => void;
  codeFocus: boolean;
  onToggleCodeFocus: () => void;
}) {
  const {
    value, onChange, placeholder, textareaRef, fileInputRef, attachments, image, busy, recorderState,
  } = props;
  const [dragging, setDragging] = useState(false);
  // Enter-to-send only where there is a Shift key to make a new line with.
  const touchKeyboard = useRef(false);
  useEffect(() => {
    const query = window.matchMedia?.("(hover: none) and (pointer: coarse)");
    if (!query) return;
    const sync = () => { touchKeyboard.current = query.matches; };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const recording = recorderState !== "idle";
  const hasText = value.trim().length > 0;
  const hasAttachments = attachments.length > 0 || Boolean(image);
  const canSend = (hasText || hasAttachments) && !busy && !props.uploadingImage && !props.transcribing;

  // Grow with the text up to a third of the screen, then scroll inside.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const limit = Math.min(220, Math.max(96, Math.round(window.innerHeight * 0.34)));
    el.style.height = `${Math.min(el.scrollHeight, limit)}px`;
    el.style.overflowY = el.scrollHeight > limit ? "auto" : "hidden";
  }, [value, recording, textareaRef]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // An IME confirms its composition with Enter — that is not "send".
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (touchKeyboard.current) return;
    event.preventDefault();
    if (canSend) props.onSend();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    props.onFiles(files);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) props.onFiles(files);
  }

  return (
    <form
      onSubmit={(event) => { event.preventDefault(); if (canSend && !recording) props.onSend(); }}
      onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={onDrop}
      data-recording={recording ? "true" : undefined}
      className={cn("composer-shell relative mx-auto w-full max-w-3xl", dragging && "!border-accent")}
      aria-label="Message composer"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) props.onFiles(files);
        }}
      />

      {recording ? (
        <VoiceRecordingPanel
          paused={recorderState === "paused"}
          requesting={recorderState === "requesting"}
          elapsedMs={props.recorderElapsedMs}
          canvasRef={props.recorderCanvasRef}
          hasWaveform={props.recorderHasWaveform}
          language={props.voiceLanguage}
          onLanguage={props.onVoiceLanguage}
          onCancel={props.onCancelVoice}
          onPause={props.onPauseVoice}
          onStop={props.onStopVoice}
          onTranscribe={props.onTranscribeVoice}
        />
      ) : (
        <>
          {hasAttachments || props.uploadingImage ? (
            <ul className="no-scrollbar flex gap-1.5 overflow-x-auto px-2.5 pt-2.5" aria-label="Attachments">
              {props.uploadingImage ? (
                <li className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 text-xs text-ink-2">
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Uploading image…
                </li>
              ) : null}
              {image ? (
                <li className="inline-flex h-11 max-w-[15rem] shrink-0 items-center gap-2 rounded-xl border border-border bg-surface-2 py-1 pl-1 pr-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-ink">{image.name}</span>
                    <span className="block text-[11px] text-ink-3">{formatSize(image.size)}</span>
                  </span>
                  <button type="button" onClick={props.onRemoveImage} aria-label={`Remove ${image.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-danger">
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ) : null}
              {attachments.map((file) => (
                <li key={file.name} className="inline-flex h-11 max-w-[15rem] shrink-0 items-center gap-2 rounded-xl border border-border bg-surface-2 py-1 pl-2.5 pr-1">
                  <span className="shrink-0 text-ink-3">{fileIcon(file.name)}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11.5px] text-ink">{file.name}</span>
                    <span className="block text-[10.5px] text-ink-3">{formatSize(file.size)}</span>
                  </span>
                  <button type="button" onClick={() => props.onRemoveAttachment(file.name)} aria-label={`Remove ${file.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-danger">
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {props.webSearch || props.codeFocus ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {props.webSearch ? (
                <button type="button" onClick={props.onToggleWebSearch} aria-label="Turn off web knowledge" className="inline-flex min-h-7 items-center gap-1.5 rounded-full bg-accent-soft pl-2.5 pr-1.5 text-[11.5px] font-medium text-accent">
                  <Globe size={12} aria-hidden="true" /> Web knowledge <X size={12} aria-hidden="true" />
                </button>
              ) : null}
              {props.codeFocus ? (
                <button type="button" onClick={props.onToggleCodeFocus} aria-label="Turn off code focus" className="inline-flex min-h-7 items-center gap-1.5 rounded-full bg-accent-soft pl-2.5 pr-1.5 text-[11.5px] font-medium text-accent">
                  <Code2 size={12} aria-hidden="true" /> Code focus <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}

          {props.transcribing ? <div className="pt-1.5"><VoiceTranscribing onCancel={props.onCancelTranscribe} /></div> : null}

          <div className="flex items-end gap-1 p-1.5">
            <Popover
              label="Add to message"
              sheetTitle="Add to message"
              align="left"
              panelClassName="w-60"
              trigger={({ toggle, open, aria }) => (
                <button type="button" onClick={toggle} aria-label="Add attachments and tools" title="Attach files" className={cn(ROUND, open ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink")} {...aria}>
                  <Plus size={19} strokeWidth={1.8} className={cn("transition-transform duration-150", open && "rotate-45")} aria-hidden="true" />
                </button>
              )}
            >
              {({ close }) => (
                <>
                  <MenuItem icon={<Paperclip size={15} />} description="Text, code and documents" onClick={() => { close(); fileInputRef.current?.click(); }}>
                    Attach files
                  </MenuItem>
                  <MenuItem icon={<Globe size={15} />} checked={props.webSearch} description="Use up-to-date public knowledge" onClick={() => { props.onToggleWebSearch(); close(); }}>
                    Web knowledge
                  </MenuItem>
                  <MenuItem icon={<Code2 size={15} />} checked={props.codeFocus} description="Answer with complete, runnable code" onClick={() => { props.onToggleCodeFocus(); close(); }}>
                    Code focus
                  </MenuItem>
                </>
              )}
            </Popover>

            <textarea
              ref={textareaRef}
              value={value}
              dir="auto"
              rows={1}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={placeholder}
              aria-label="Message MATRIX"
              enterKeyHint="enter"
              autoComplete="off"
              className="composer-input min-h-10 flex-1 self-center px-1.5 py-2"
            />

            {busy ? (
              <button type="button" onClick={props.onStop} aria-label="Stop generating" title="Stop generating" className={cn(ROUND, "bg-ink text-bg hover:opacity-85")}>
                <Square size={13} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <>
                {/* With attachments ready, voice stays available next to Send;
                    with only text, Send is the single primary action. */}
                {!hasText || hasAttachments ? (
                  <button
                    type="button"
                    onClick={props.onStartVoice}
                    disabled={props.transcribing}
                    aria-label={hasAttachments ? "Record a voice message with these attachments" : "Record a voice message"}
                    title="Record a voice message"
                    className={cn(ROUND, hasAttachments || hasText ? "text-ink-2 hover:bg-surface-2 hover:text-ink" : "bg-surface-2 text-ink hover:bg-surface-3", "disabled:opacity-40")}
                  >
                    <Mic size={18} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                ) : null}
                {hasText || hasAttachments ? (
                  <button type="submit" disabled={!canSend} aria-label={props.sendLabel} title={props.sendLabel} className={cn(ROUND, "bg-accent text-[var(--primary-contrast)] hover:bg-accent-hover disabled:opacity-45")}>
                    <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>
      )}
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[inherit] bg-surface/90 text-sm font-medium text-accent" aria-hidden="true">
          Drop files to attach
        </div>
      ) : null}
    </form>
  );
}
