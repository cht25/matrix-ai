"use client";

// Voice input UI that lives INSIDE the chat composer (all modes, incl. Agent):
// the recording panel replaces the text field while listening, and the review
// bar sits above the (editable) transcript afterwards. Presentation only — the
// capture logic stays in ChatClient next to the composer state it drives.

import type { RefObject } from "react";
import { Languages, Loader2, Mic, Pause, Play, RotateCcw, Square, Trash2, X } from "lucide-react";
import { VOICE_LANGUAGES, formatClock, languageLabel, voiceLanguage } from "@/lib/voice-input";
import { cn } from "@/lib/utils";

export type VoiceReview = {
  source: "browser" | "server";
  /** Detected (server) or selected (browser) language code. */
  language: string | null;
  durationMs: number;
  /** Stored private recording, when the deployment keeps voice messages. */
  asset?: { id: string; durationMs: number; waveform: number[]; language: string | null } | null;
};

export function VoiceLanguageSelect({ value, onChange, disabled, className }: { value: string; onChange: (code: string) => void; disabled?: boolean; className?: string }) {
  return (
    <label className={cn("inline-flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 text-[12px] text-ink-2", disabled && "opacity-60", className)}>
      <Languages size={13} aria-hidden="true" className="shrink-0" />
      <span className="sr-only">Voice input language</span>
      <select
        value={voiceLanguage(value).code}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label="Voice input language"
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

export function VoiceRecordingPanel(props: {
  paused: boolean;
  seconds: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Words recognised so far (browser engine); empty for server transcription. */
  liveTranscript: string;
  /** Short explanation of where transcription happens. */
  engineNote: string;
  /** False when only speech recognition (no recorder, no waveform) is running. */
  hasWaveform: boolean;
  canPause: boolean;
  language: string;
  onLanguage: (code: string) => void;
  onCancel: () => void;
  onPause: () => void;
  onStop: () => void;
}) {
  const status = props.paused ? "Paused" : "Listening";
  return (
    <div className="flex min-h-24 w-full min-w-0 flex-col justify-center gap-2" role="group" aria-label="Voice recording composer">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full bg-danger", !props.paused && "animate-pulse")} aria-hidden="true" />
        <span className="shrink-0 font-mono text-sm tabular-nums text-danger" role="timer" aria-live="off">
          {status} · {formatClock(props.seconds)}
        </span>
        {props.hasWaveform ? (
          <canvas ref={props.canvasRef} height={40} aria-label="Live microphone waveform" role="img" className="h-10 min-w-0 flex-1" />
        ) : (
          <span className="flex h-10 min-w-0 flex-1 items-center gap-1" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => (
              <span key={index} className={cn("w-1 rounded-full bg-danger/70", !props.paused && "animate-pulse")} style={{ height: `${8 + ((index * 7) % 22)}px`, animationDelay: `${index * 60}ms` }} />
            ))}
          </span>
        )}
      </div>
      <p className="min-h-5 break-words text-[13px] leading-5 text-ink-2" aria-live="polite" dir="auto">
        {props.liveTranscript ? props.liveTranscript : <span className="text-ink-3">{props.engineNote}</span>}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={props.onCancel} aria-label="Cancel recording" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-ink-2 hover:text-ink">
            <X size={15} aria-hidden="true" /> Cancel
          </button>
          <VoiceLanguageSelect value={props.language} onChange={props.onLanguage} />
        </div>
        <div className="flex items-center gap-2">
          {props.canPause ? (
            <button type="button" onClick={props.onPause} aria-label={props.paused ? "Resume recording" : "Pause recording"} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm">
              {props.paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
              <span className="hidden sm:inline">{props.paused ? "Resume" : "Pause"}</span>
            </button>
          ) : null}
          <button type="button" onClick={props.onStop} className="flex min-h-11 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-semibold text-white" aria-label="Stop recording and review the transcript">
            <Square size={15} fill="currentColor" aria-hidden="true" /> Stop
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shown while the recording is being transcribed. */
export function VoiceProcessing({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="mx-auto mb-2 flex max-w-2xl items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink-2" role="status" aria-live="polite">
      <span className="flex min-w-0 items-center gap-2"><Loader2 size={15} className="shrink-0 animate-spin text-accent" aria-hidden="true" /><span className="truncate">Transcribing your voice…</span></span>
      <button type="button" onClick={onCancel} className="min-h-9 shrink-0 rounded-lg px-2 text-[12px] text-ink-3 hover:text-ink">Cancel</button>
    </div>
  );
}

/** Sits above the composer once a transcript is in the text field. */
export function VoiceReviewBar(props: {
  review: VoiceReview;
  language: string;
  onLanguage: (code: string) => void;
  /** The recording is still available to transcribe again in another language. */
  canRetranscribe: boolean;
  busy: boolean;
  onRetranscribe: () => void;
  onRecordMore: () => void;
  onDiscard: () => void;
}) {
  const detected = languageLabel(props.review.language);
  return (
    <div className="mx-auto mb-2 flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent/30 bg-accent-soft/40 px-3 py-2 text-[12.5px] text-ink-2" role="status" aria-label="Voice transcript ready to review">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Mic size={14} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0">
          <span className="font-medium text-ink">Transcript ready — edit it below, then send.</span>{" "}
          <span className="text-ink-3">
            {formatClock(props.review.durationMs / 1000)}
            {detected ? ` · ${detected}` : ""}
            {props.review.source === "browser" ? " · on-device" : ""}
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        {props.canRetranscribe ? (
          <>
            <VoiceLanguageSelect value={props.language} onChange={props.onLanguage} disabled={props.busy} />
            <button type="button" onClick={props.onRetranscribe} disabled={props.busy} title="Transcribe the same recording again in the selected language" className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border bg-surface px-2 text-[12px] text-ink hover:bg-surface-2 disabled:opacity-50">
              <RotateCcw size={13} aria-hidden="true" /> Redo
            </button>
          </>
        ) : null}
        <button type="button" onClick={props.onRecordMore} disabled={props.busy} aria-label="Record more and append to the transcript" title="Record more" className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface text-ink hover:bg-surface-2 disabled:opacity-50">
          <Mic size={14} aria-hidden="true" />
        </button>
        <button type="button" onClick={props.onDiscard} disabled={props.busy} aria-label="Discard the voice transcript" title="Discard" className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface text-ink-2 hover:text-danger disabled:opacity-50">
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
