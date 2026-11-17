"use client";

// Voice UI that lives INSIDE the chat composer (Chat and Agent share it).
//
// Mode A (Default — Voice message):
//   [✕ Cancel]  ● 0:07  ▂▅▃▆▂▅▇▃▂  [Aa Text] [➤ Send]
//   Stop → Send finalizes the recording, transcribes it and submits the turn
//   ONCE. The conversation shows the audio bubble with playback and the
//   transcript; no second click on Send is needed. [Aa Text] is the opt-out
//   that puts the transcript in the composer for editing instead.
//
// Mode B (Opt-in — Hands-free Conversation):
//   VAD automatically detects pause-after-speech, transcribes, and sends as text.

import type { RefObject } from "react";
import { AudioLines, Check, Languages, Loader2, Pause, Play, Square, X } from "lucide-react";
import { VOICE_LANGUAGES, formatClock, voiceLanguage, type VoiceInputMode } from "@/lib/voice-input";
import { cn } from "@/lib/utils";

export function VoiceLanguageSelect({ value, onChange, disabled, className }: { value: string; onChange: (code: string) => void; disabled?: boolean; className?: string }) {
  return (
    <label className={cn("inline-flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 text-[12px] text-ink-2", disabled && "opacity-60", className)}>
      <Languages size={13} aria-hidden="true" className="shrink-0" />
      <span className="sr-only">Voice language</span>
      <select
        value={voiceLanguage(value).code}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label="Voice language"
        className="min-w-0 max-w-[9.5rem] cursor-pointer truncate bg-transparent py-1 text-[12px] text-ink outline-none"
      >
        {VOICE_LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.code === "auto" ? "Auto-detect" : `${language.label} · ${language.native}`}
          </option>
        ))}
      </select>
    </label>
  );
}

const ICON_BUTTON = "grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40";

export function VoiceRecordingPanel(props: {
  paused: boolean;
  /** True while the browser is still asking for the microphone. */
  requesting: boolean;
  elapsedMs: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** False when only speech recognition (no recorder, no audio) is running. */
  hasWaveform: boolean;
  /** Live recognized preview text when available alongside capture. */
  liveText?: string;
  /** True once audio energy crossed speech threshold. */
  speechDetected?: boolean;
  /** Default "dictate" puts words in composer; "hands_free" auto-sends turn. */
  voiceMode?: VoiceInputMode;
  language: string;
  onLanguage: (code: string) => void;
  onCancel: () => void;
  onPause: () => void;
  /** Primary stop action (Mode A: transcribe to composer; Mode B: send turn). */
  onStop: () => void;
  /** Opt-out: transcribe into the message box instead of sending. */
  onDictateOnly?: () => void;
}) {
  const isHandsFree = props.voiceMode === "hands_free";
  const status = props.requesting ? "Waiting for the microphone" : props.paused ? "Paused" : isHandsFree ? "Hands-free listening" : "Listening";
  const clock = formatClock(props.elapsedMs / 1000);
  return (
    <div className="flex w-full min-w-0 flex-col" role="group" aria-label="Voice recording">
      <div className="flex min-h-14 w-full min-w-0 items-center gap-1 px-1.5 py-1.5 sm:gap-2 sm:px-2">
        <button type="button" onClick={props.onCancel} aria-label="Cancel recording" title="Cancel recording" className={ICON_BUTTON}>
          <X size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>

        <span className="flex shrink-0 items-center gap-2 pl-0.5" role="timer" aria-live="off" aria-label={`${status}, ${clock}`}>
          <span className={cn("h-2.5 w-2.5 rounded-full bg-danger", !props.paused && !props.requesting && "pulse-dot")} aria-hidden="true" />
          <span className="font-mono text-sm tabular-nums text-ink">{clock}</span>
        </span>
        <span className="sr-only" role="status">{status}</span>

        {props.hasWaveform ? (
          <canvas ref={props.canvasRef} aria-label="Live microphone level" role="img" className="h-9 min-w-0 flex-1 text-danger" />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">Listening — Send transcribes and sends this as one message.</span>
        )}

        <VoiceLanguageSelect value={props.language} onChange={props.onLanguage} className="hidden border-0 bg-transparent md:inline-flex" />

        {props.hasWaveform ? (
          <button type="button" onClick={props.onPause} disabled={props.requesting} aria-label={props.paused ? "Resume recording" : "Pause recording"} title={props.paused ? "Resume" : "Pause"} className={cn(ICON_BUTTON, "hidden sm:grid")}>
            {props.paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
          </button>
        ) : null}

        {props.hasWaveform && props.onDictateOnly && !isHandsFree ? (
          <button
            type="button"
            onClick={props.onDictateOnly}
            disabled={props.requesting}
            aria-label="Stop and transcribe into the message box without sending"
            title="Only transcribe — put the words in the message box instead of sending"
            className="hidden h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 sm:inline-flex"
          >
            <AudioLines size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>Text</span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={props.onStop}
          disabled={props.requesting}
          aria-label={isHandsFree ? "Stop and send voice turn" : "Stop, transcribe and send this voice message"}
          title={isHandsFree ? "Send voice turn" : "Send voice message"}
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-50 sm:px-4",
            "bg-accent-solid text-accent-ink"
          )}
        >
          {isHandsFree ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <Check size={15} strokeWidth={2.4} aria-hidden="true" />}
          <span>Send</span>
        </button>
      </div>

      {props.liveText || isHandsFree ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 text-[12px] text-ink-2">
          <span className="min-w-0 truncate" dir="auto">
            {props.liveText || (isHandsFree ? (props.speechDetected ? "Speaking — pause briefly to send…" : "Hands-free ready — start speaking…") : "")}
          </span>
          {isHandsFree ? (
            <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-medium text-accent">
              Hands-free
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Shown in the composer while a recording is being turned into text. */
export function VoiceTranscribing({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-2 px-3 text-[13px] text-ink-2" role="status" aria-live="polite">
      <span className="flex min-w-0 items-center gap-2">
        <Loader2 size={14} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
        <span className="truncate">Transcribing — your message sends automatically when it is ready…</span>
      </span>
      <button type="button" onClick={onCancel} className="min-h-9 shrink-0 rounded-lg px-2 text-[12px] font-medium text-ink-3 hover:text-ink">Cancel</button>
    </div>
  );
}
