"use client";

// A voice message inside the conversation (Chat and Agent share it).
//
// The bubble IS the audio: play / pause, a seekable waveform drawn from the
// amplitudes captured while recording, and the duration. The words are a
// separate, explicit step — [Transcribe] reveals the transcript in place, and
// it can then be corrected.
//
// Audio is fetched only when Play is pressed, so a long history full of voice
// messages costs no network requests until the user actually listens.

import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AlertCircle, Loader2, Pause, Pencil, Play, RotateCcw, Trash2, Type } from "lucide-react";
import { formatClock, isRtlText, languageLabel } from "@/lib/voice-input";
import { cn } from "@/lib/utils";

export type VoiceMessageStatus = "processing" | "failed" | "ready";

export const VoiceMessage = memo(function VoiceMessage({
  src, transcript, waveform, durationMs, language, status = "ready", error, local = false,
  onRetry, onDiscard, onEditTranscript,
}: {
  /** Playback URL: a local object URL, or the owner-checked /api/voice/audio route. */
  src: string;
  transcript: string;
  waveform?: number[];
  durationMs?: number;
  language?: string | null;
  status?: VoiceMessageStatus;
  error?: string | null;
  /** True when the recording exists only in this browser session. */
  local?: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
  onEditTranscript?: () => void;
}) {
  const player = useRef<HTMLAudioElement>(null);
  const transcriptId = useId();
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playError, setPlayError] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, (durationMs ?? 0) / 1000));
  const [showTranscript, setShowTranscript] = useState(false);

  useEffect(() => { if (durationMs) setDuration(durationMs / 1000); }, [durationMs]);
  // A different recording in the same row starts from the beginning.
  useEffect(() => { setProgress(0); setPlaying(false); setPlayError(false); }, [src]);

  const samples = (waveform ?? []).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100).slice(0, 64);
  // Older messages stored no amplitudes: show an even, neutral track rather
  // than inventing a waveform that was never measured.
  const bars = samples.length >= 4 ? samples : Array.from({ length: 32 }, () => 18);
  const ratio = duration > 0 ? Math.min(1, progress / duration) : 0;
  const detected = languageLabel(language);

  function toggle() {
    const audio = player.current;
    if (!audio) return;
    if (!audio.paused) { audio.pause(); return; }
    setPlayError(false);
    setLoading(true);
    void audio.play().catch(() => { setPlaying(false); setPlayError(true); }).finally(() => setLoading(false));
  }

  function seekTo(fraction: number) {
    const audio = player.current;
    if (!audio || !duration) return;
    const next = Math.max(0, Math.min(duration, fraction * duration));
    setProgress(next);
    try { audio.currentTime = next; } catch { /* not seekable until loaded */ }
  }

  function onTrackClick(event: MouseEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) seekTo((event.clientX - box.left) / box.width);
  }

  function onTrackKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!duration) return;
    const step = Math.max(1, duration / 20);
    if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); seekTo((progress + step) / duration); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); seekTo((progress - step) / duration); }
    else if (event.key === "Home") { event.preventDefault(); seekTo(0); }
    else if (event.key === "End") { event.preventDefault(); seekTo(1); }
  }

  return (
    <div className="w-full min-w-0 max-w-[19rem] sm:w-[19rem]" role="group" aria-label="Voice message">
      <audio
        ref={player}
        preload="none"
        src={src}
        onLoadedMetadata={(event) => { const d = event.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDuration(d); }}
        onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onError={() => { setPlaying(false); setLoading(false); setPlayError(true); }}
      />
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause voice message" : "Play voice message"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-[var(--primary-contrast)] transition-colors hover:bg-accent-hover"
        >
          {loading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : playing ? <Pause size={16} fill="currentColor" aria-hidden="true" /> : <Play size={16} fill="currentColor" className="translate-x-px" aria-hidden="true" />}
        </button>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek within voice message"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(progress)}
          aria-valuetext={`${formatClock(progress)} of ${formatClock(duration)}`}
          onClick={onTrackClick}
          onKeyDown={onTrackKey}
          className="voice-bars flex-1 cursor-pointer rounded-md"
        >
          {bars.map((n, i) => (
            <span key={i} aria-hidden="true" className={(i + 0.5) / bars.length <= ratio ? "text-accent" : "text-ink-3/55"} style={{ height: `${Math.max(12, Math.min(100, n * 0.95 + 8))}%` }} />
          ))}
        </div>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-2">{formatClock(playing || progress > 0 ? progress : duration)}</span>
      </div>

      {status === "processing" ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3" role="status" aria-live="polite">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Sending voice message…
        </p>
      ) : status === "failed" ? (
        <div className="mt-2 space-y-2" role="alert">
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-danger">
            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error || "This voice message could not be sent."} Your recording is kept.</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {onRetry ? <button type="button" onClick={onRetry} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-surface-3"><RotateCcw size={13} aria-hidden="true" /> Try again</button> : null}
            {onDiscard ? <button type="button" onClick={onDiscard} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface hover:text-danger"><Trash2 size={13} aria-hidden="true" /> Discard</button> : null}
          </div>
        </div>
      ) : (
        <div className="mt-1.5">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
            <button
              type="button"
              onClick={() => setShowTranscript((value) => !value)}
              aria-expanded={showTranscript}
              aria-controls={transcriptId}
              className={cn("-ml-1.5 inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1.5 text-[12px] font-medium transition-colors", showTranscript ? "text-accent" : "text-ink-2 hover:text-ink")}
            >
              <Type size={13} aria-hidden="true" />
              {showTranscript ? "Hide transcript" : "Transcribe"}
            </button>
            {detected ? <span className="text-[11px] text-ink-3">{detected}</span> : null}
            {local ? <span className="text-[11px] text-ink-3" title="This recording is kept in this browser session only">· this session only</span> : null}
          </div>
          {showTranscript ? (
            <div id={transcriptId} className="mt-1 rounded-lg border border-border bg-surface/70 px-2.5 py-2">
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink" dir={isRtlText(transcript) ? "rtl" : "auto"}>{transcript || "No words were recognised in this recording."}</p>
              {onEditTranscript ? (
                <button type="button" onClick={onEditTranscript} className="-ml-1 mt-1 inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1.5 text-[12px] font-medium text-ink-2 hover:text-ink">
                  <Pencil size={12} aria-hidden="true" /> Edit transcript
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {playError ? <p className="mt-1.5 text-[11.5px] text-warning" role="status">This recording could not be played right now.</p> : null}
    </div>
  );
});
