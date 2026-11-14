"use client";

import { useRef, useState } from "react";
import { Play, Pause, Trash2 } from "lucide-react";

/** Uses amplitudes captured from the real recording. Older messages without
 * stored samples keep native browser controls rather than a synthetic wave. */
export function VoiceMessage({ id, transcript, waveform, durationMs, language, onDelete }: {
  id: string; transcript: string; waveform?: number[]; durationMs?: number; language?: string | null; onDelete: () => void;
}) {
  const player = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, (durationMs ?? 0) / 1000));
  const samples = (waveform ?? []).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100).slice(0, 64);
  const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  return <div className="mt-1 w-full min-w-0 max-w-[20rem] space-y-2" aria-label="Voice message">
    {samples.length > 0 ? <audio ref={player} preload="metadata" src={`/api/voice/audio/${encodeURIComponent(id)}`}
      onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : duration)}
      onTimeUpdate={(e) => setProgress(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setProgress(0); }} /> : null}
    <div className="flex min-w-0 items-center gap-2">
      {samples.length > 0 ? <button type="button" onClick={() => { const audio = player.current; if (!audio) return; if (audio.paused) void audio.play().catch(() => setPlaying(false)); else audio.pause(); }}
        aria-label={playing ? "Pause voice message" : "Play voice message"} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-white">
        {playing ? <Pause size={17} /> : <Play size={17} />}
      </button> : null}
      {samples.length ? <button type="button" aria-label="Seek within voice message" className="flex h-11 min-w-0 flex-1 items-center gap-px overflow-hidden" onClick={(e) => { const audio = player.current; if (!audio || !duration) return; audio.currentTime = Math.max(0, Math.min(duration, ((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth) * duration)); }}>
        {samples.map((n, i) => <span key={i} aria-hidden="true" className={`min-w-px flex-1 rounded-full ${i / samples.length <= progress / (duration || 1) ? "bg-accent" : "bg-ink-3/50"}`} style={{ height: `${Math.max(3, n * 0.28)}px` }} />)}
      </button> : <div className="min-w-0 flex-1"><audio controls preload="none" src={`/api/voice/audio/${encodeURIComponent(id)}`} className="h-9 w-full" aria-label="Play older voice recording" /></div>}
      {samples.length > 0 ? <span className="shrink-0 font-mono text-[11px] text-ink-2">{time(progress)} / {time(duration)}</span> : null}
      <button type="button" onClick={onDelete} aria-label="Delete private voice recording" className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-3 hover:text-danger"><Trash2 size={14} /></button>
    </div>
    <details className="text-left text-xs text-ink-2"><summary className="cursor-pointer">Transcript{language ? ` · ${language}` : ""}</summary><p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{transcript}</p></details>
  </div>;
}
