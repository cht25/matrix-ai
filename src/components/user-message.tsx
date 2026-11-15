"use client";

// =============================================================================
// One user message (Chat and Agent share it).
//
//   ┌──────────────────────────────┐
//   │ text  — or —  voice message  │   bubble
//   │ [file.ts] [notes.md]         │   attachments sent with it
//   └──────────────────────────────┘
//      12:04 · edited     Copy  Edit  ⋯
//
// Editing happens in place: the bubble becomes a text field with
// [Cancel] [Send]. For the latest turn that re-asks the question (Edit &
// resend); for an older voice message it only corrects the transcript.
//
// Memoized: a streaming reply, a build update or typing in the composer never
// re-renders the user messages above it.
// =============================================================================

import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, FileCode2, FileText, RotateCcw } from "lucide-react";
import { ResponseActions, type ChatAction } from "@/components/response-actions";
import { VoiceMessage } from "@/components/voice-message";
import { isRtlText } from "@/lib/voice-input";
import type { ChatMessage } from "@/lib/chat-messages";
import { cn } from "@/lib/utils";

export type UserMessageProps = {
  message: ChatMessage;
  timeLabel: string;
  actions: { primary: ChatAction[]; overflow: ChatAction[] };
  /** The inline editor is open for this message. */
  editing: boolean;
  /** "resend" re-asks the question; "transcript" only corrects the text. */
  editMode: "resend" | "transcript";
  saving: boolean;
  onSubmitEdit: (text: string) => void;
  onCancelEdit: () => void;
  onEditTranscript?: () => void;
  onRetrySend?: () => void;
  onRetryVoice?: () => void;
  onDiscardVoice?: () => void;
  animate: boolean;
};

const MAX_CHARS = 12_000;

function InlineEditor({ initial, mode, saving, onSubmit, onCancel }: { initial: string; mode: "resend" | "transcript"; saving: boolean; onSubmit: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* unsupported */ }
  }, []);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [value]);

  const text = value.trim();
  const unchanged = text === initial.trim();
  const canSubmit = Boolean(text) && !saving && text.length <= MAX_CHARS && !(mode === "transcript" && unchanged);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // Touch keyboards have no Shift+Enter: Enter stays a new line there.
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    event.preventDefault();
    if (canSubmit) onSubmit(text);
  }

  return (
    <div className="w-full rounded-2xl border border-accent/60 bg-surface p-2 shadow-[0_0_0_3px_var(--primary-soft)]">
      <textarea
        ref={field}
        value={value}
        dir="auto"
        rows={1}
        maxLength={MAX_CHARS}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={mode === "resend" ? "Edit your message" : "Edit transcript"}
        className="composer-input max-h-[280px] min-h-10 px-2 py-1.5"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate px-2 text-[11.5px] text-ink-3">
          {mode === "resend" ? "Sending replaces the answer below." : "Corrects the text of this voice message."}
        </p>
        <div className="flex shrink-0 gap-1.5">
          <button type="button" onClick={onCancel} disabled={saving} className="min-h-9 rounded-lg px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => canSubmit && onSubmit(text)} disabled={!canSubmit} className="min-h-9 rounded-lg bg-accent px-3.5 text-[13px] font-semibold text-[var(--primary-contrast)] hover:bg-accent-hover disabled:opacity-45">
            {saving ? "Saving…" : mode === "resend" ? "Send" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export const UserMessage = memo(function UserMessage(props: UserMessageProps) {
  const { message, timeLabel, actions, editing, editMode, saving, animate } = props;
  const meta = message.metadata ?? {};
  const voiceSrc = meta.local_audio_url ?? (meta.audio_asset_id ? `/api/voice/audio/${encodeURIComponent(meta.audio_asset_id)}` : null);
  const isVoice = Boolean(voiceSrc);
  const names = meta.attachment_names ?? [];
  const settled = !meta.voice_status;

  return (
    <div className={cn("msg-row flex flex-col items-end", animate && "msg-in")} data-role="user">
      {editing ? (
        <div className="w-full sm:max-w-[85%]">
          <InlineEditor initial={message.content} mode={editMode} saving={saving} onSubmit={props.onSubmitEdit} onCancel={props.onCancelEdit} />
        </div>
      ) : (
        <div className="flex min-w-0 max-w-[88%] flex-col items-end sm:max-w-[75%]">
          <div className={cn("user-bubble min-w-0 max-w-full", isVoice ? "px-3 py-2.5" : "px-4 py-2.5")}>
            {isVoice && voiceSrc ? (
              <VoiceMessage
                src={voiceSrc}
                transcript={message.content}
                durationMs={meta.audio_duration_ms}
                waveform={meta.audio_waveform}
                language={meta.audio_language}
                status={meta.voice_status ?? "ready"}
                error={meta.voice_error}
                local={Boolean(meta.local_audio_url) && !meta.audio_asset_id && settled}
                onRetry={props.onRetryVoice}
                onDiscard={props.onDiscardVoice}
                onEditTranscript={settled ? props.onEditTranscript : undefined}
              />
            ) : (
              <p className="whitespace-pre-wrap break-words" dir={isRtlText(message.content) ? "rtl" : "auto"}>{message.content}</p>
            )}
            {names.length ? (
              <ul className={cn("flex flex-wrap gap-1.5", (isVoice || message.content) && "mt-2 border-t border-border pt-2")} aria-label="Attached files">
                {names.map((name) => (
                  <li key={name} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 font-mono text-[11px] text-ink-2">
                    {/\.(md|mdx|txt|log|csv)$/i.test(name) ? <FileText size={12} className="shrink-0" aria-hidden="true" /> : <FileCode2 size={12} className="shrink-0" aria-hidden="true" />}
                    <span className="truncate">{name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {meta.send_failed ? (
            <p className="mt-1 flex items-center gap-1.5 text-[12px] text-danger" role="alert">
              <AlertCircle size={13} aria-hidden="true" />
              Not sent
              {props.onRetrySend ? (
                <button type="button" onClick={props.onRetrySend} className="ml-0.5 inline-flex min-h-9 items-center gap-1 rounded-lg px-1.5 font-medium text-ink underline decoration-border underline-offset-2 hover:decoration-current">
                  <RotateCcw size={12} aria-hidden="true" /> Try again
                </button>
              ) : null}
            </p>
          ) : null}

          {settled ? (
            <div className="mt-0.5 flex max-w-full flex-wrap items-center justify-end gap-x-1.5">
              {timeLabel ? (
                <span className="px-0.5 font-mono text-[10.5px] text-ink-3">
                  {timeLabel}
                  {meta.edited_at ? <span title="This message was edited after it was sent"> · edited</span> : null}
                </span>
              ) : null}
              <ResponseActions primary={actions.primary} overflow={actions.overflow} align="end" quiet menuLabel="More message actions" />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});
