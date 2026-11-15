"use client";

// =============================================================================
// Voice capture for the chat composer (Chat and Agent share it).
//
// This hook only RECORDS. What happens to a finished recording — send it as a
// voice message, or transcribe it into the composer — is decided by the caller.
// Three things that must never be confused live in three different places:
//
//   recording      → here (MediaRecorder + live level meter)
//   transcription  → POST /api/voice/transcribe (Whisper)
//   AI speech      → /api/voice/speech and the browser's speech synthesis
//
// Works on desktop and mobile browsers: the container/codec is negotiated with
// MediaRecorder.isTypeSupported (WebM/Opus on Chromium and Firefox, MP4/AAC on
// Safari and iOS), the meter is optional, and every failure maps to a plain
// sentence. A browser with no recorder at all falls back to its own speech
// recognition, which can only produce text (no audio message).
// =============================================================================

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { chooseVoiceEngine, mergeTranscript, voiceErrorMessage } from "@/lib/voice-input";

export type VoiceClip = {
  blob: Blob;
  /** Object URL for local playback. The owner revokes it when done. */
  url: string;
  filename: string;
  mimeType: string;
  durationMs: number;
  /** 4–64 integer peaks (0–100) covering the WHOLE clip. */
  waveform: number[];
  /**
   * What the browser's own speech recognition heard, when it could run next to
   * the recorder (desktop, a specific language). Only a fallback for when the
   * speech service cannot transcribe the recording.
   */
  heard: string;
};

export type VoiceCapture =
  | { kind: "clip"; clip: VoiceClip }
  /** Recognition-only browsers: words, but no audio to send. */
  | { kind: "transcript"; text: string; durationMs: number };

export type RecorderState = "idle" | "requesting" | "recording" | "paused";

export const MAX_RECORDING_MS = 600_000;
export const MIN_RECORDING_MS = 400;
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

/** First recording format this browser can actually produce ("" = its default). */
export function pickRecordingMimeType(isSupported: (type: string) => boolean): string {
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (isSupported(candidate)) return candidate;
    } catch { /* a throwing isTypeSupported means "no" */ }
  }
  return "";
}

/** File extension the speech service and storage expect for a MIME type. */
export function extensionForMime(mime: string): string {
  const type = mime.toLowerCase();
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  if (type.includes("mpeg")) return "mp3";
  return "webm";
}

/**
 * The container a recording really is, read from its first bytes. Some
 * browsers report an empty or generic MIME type; the speech service checks the
 * actual container, so the label has to be right.
 */
export function sniffAudioMime(head: Uint8Array): string | null {
  const ascii = (from: number, length: number) => String.fromCharCode(...head.slice(from, from + length));
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "audio/webm";
  if (head.length >= 12 && ascii(4, 4) === "ftyp") return ascii(8, 4).toLowerCase().startsWith("3gp") ? "audio/3gpp" : "audio/mp4";
  if (head.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (head.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac";
  if (head.length >= 3 && (ascii(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0))) return "audio/mpeg";
  return null;
}

/**
 * Reduce every level sample taken during a recording to `bars` peaks, so the
 * stored waveform describes the whole message — not just its last seconds.
 */
export function summarizeWaveform(levels: number[], bars = 48): number[] {
  if (!levels.length) return [];
  const count = Math.max(4, Math.min(64, bars));
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j += 1) peak = Math.max(peak, levels[j]);
    out.push(Math.max(0, Math.min(100, Math.round(peak))));
  }
  return out;
}

export function recorderSupport(): { recorder: boolean; recognition: boolean; secure: boolean } {
  if (typeof window === "undefined") return { recorder: false, recognition: false, secure: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vendor-prefixed constructor
  const recognition = Boolean((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);
  return {
    recorder: Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined",
    recognition,
    secure: window.isSecureContext !== false,
  };
}

type Options = {
  /** BCP-47 code for recognition-only capture; "auto" follows the browser. */
  language?: string;
  /** The recording ended on its own: time limit reached or the microphone was lost. */
  onAutoStop?: (capture: VoiceCapture | null, reason: "limit" | "device") => void;
};

export function useVoiceRecorder(options: Options = {}): {
  state: RecorderState;
  elapsedMs: number;
  /** False when only speech recognition is running (no audio, no meter). */
  hasWaveform: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  start: () => Promise<{ ok: true } | { ok: false; message: string }>;
  stop: () => Promise<VoiceCapture | null>;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
} {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [hasWaveform, setHasWaveform] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const levelsRef = useRef<number[]>([]);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Why the recorder stopped without the user pressing Stop or Cancel. */
  const endedRef = useRef<"limit" | "device" | "error" | null>(null);
  // Elapsed time excludes pauses: accumulated + (now - segmentStart).
  const accumulatedRef = useRef(0);
  const segmentRef = useRef<number | null>(null);
  const discardRef = useRef(false);
  const resolveRef = useRef<((capture: VoiceCapture | null) => void) | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => { optionsRef.current = options; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Web Speech API has no lib.dom typings
  const recognitionRef = useRef<any>(null);
  const recognitionWantedRef = useRef(false);
  const heardRef = useRef({ final: "", interim: "" });

  const elapsed = useCallback(() => accumulatedRef.current + (segmentRef.current === null ? 0 : performance.now() - segmentRef.current), []);

  const setGlobalRecording = useCallback((active: boolean) => {
    if (typeof document === "undefined") return;
    if (active) document.documentElement.dataset.recording = "true";
    else delete document.documentElement.dataset.recording;
  }, []);

  /** Release the microphone, the meter, the timers and the wake lock. */
  const release = useCallback(() => {
    if (clockRef.current) clearInterval(clockRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    clockRef.current = null; frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    streamRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    recognitionWantedRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) { try { recognition.stop(); } catch { /* not running */ } }
    segmentRef.current = null;
    setGlobalRecording(false);
  }, [setGlobalRecording]);

  // Leaving the page while recording would silently lose the message.
  useEffect(() => {
    if (state === "idle") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  useEffect(() => () => {
    discardRef.current = true;
    try { recorderRef.current?.stop(); } catch { /* already stopped */ }
    recorderRef.current = null;
    release();
  }, [release]);

  const startClock = useCallback(() => {
    if (clockRef.current) clearInterval(clockRef.current);
    clockRef.current = setInterval(() => {
      const ms = elapsed();
      setElapsedMs(ms);
      // The limit counts recorded time, so a pause never eats into it.
      const recorder = recorderRef.current;
      if (ms >= MAX_RECORDING_MS && recorder && recorder.state !== "inactive") {
        endedRef.current = "limit";
        try { recorder.stop(); } catch { /* already stopping */ }
      }
    }, 200);
  }, [elapsed]);

  /** Draw the scrolling level meter and keep every sample for the stored waveform. */
  const startMeter = useCallback((stream: MediaStream, recorder: MediaRecorder) => {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const context = new Ctor();
      contextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      void context.resume().catch(() => {});
      const samples = new Uint8Array(analyser.fftSize);
      let lastSample = 0;
      const draw = (time: number) => {
        if (time - lastSample >= 60 && recorder.state === "recording") {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const value of samples) sum += ((value - 128) / 128) ** 2;
          const level = Math.max(2, Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 270)));
          const levels = levelsRef.current;
          levels.push(level);
          // ~10 minutes at 60ms is 10k samples — bounded, and summarised on stop.
          if (levels.length > 12_000) levels.splice(0, levels.length - 12_000);
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (canvas && ctx) {
            const scale = window.devicePixelRatio || 1;
            const width = Math.round(canvas.clientWidth * scale);
            const height = Math.round(canvas.clientHeight * scale);
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
            ctx.clearRect(0, 0, width, height);
            // The bar colour comes from the design tokens via CSS `color`.
            ctx.fillStyle = getComputedStyle(canvas).color || "#888";
            const step = 4 * scale;
            const count = Math.max(8, Math.floor(width / step));
            for (let i = 0; i < count; i += 1) {
              const value = levels[levels.length - count + i] ?? 2;
              const bar = Math.max(2 * scale, (height * value) / 105);
              const x = i * step;
              const radius = Math.min(scale, bar / 2);
              ctx.beginPath();
              if (typeof ctx.roundRect === "function") ctx.roundRect(x, (height - bar) / 2, 2 * scale, bar, radius);
              else ctx.rect(x, (height - bar) / 2, 2 * scale, bar);
              ctx.fill();
            }
          }
          lastSample = time;
        }
        frameRef.current = requestAnimationFrame(draw);
      };
      frameRef.current = requestAnimationFrame(draw);
    } catch { /* the timer and the recording work without a meter */ }
  }, []);

  /** Recognition-only capture for browsers without MediaRecorder. */
  const startRecognition = useCallback((lang: string): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vendor-prefixed constructor
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Ctor) return false;
    try {
      const recognition = new Ctor();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SpeechRecognitionEvent
      recognition.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = String(result[0]?.transcript ?? "");
          if (result.isFinal) heardRef.current.final = mergeTranscript(heardRef.current.final, text);
          else interim += text;
        }
        heardRef.current.interim = interim.trim();
      };
      // Browsers end recognition after a pause; keep listening until Stop.
      recognition.onend = () => {
        if (recognitionWantedRef.current && recognitionRef.current === recognition) {
          try { recognition.start(); } catch { /* already restarting */ }
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SpeechRecognitionErrorEvent
      recognition.onerror = (event: any) => {
        const code = String(event?.error ?? "");
        if (code === "not-allowed" || code === "service-not-allowed" || code === "language-not-supported" || code === "network") recognitionWantedRef.current = false;
      };
      recognitionRef.current = recognition;
      recognitionWantedRef.current = true;
      recognition.start();
      return true;
    } catch {
      recognitionRef.current = null;
      recognitionWantedRef.current = false;
      return false;
    }
  }, []);

  const start = useCallback(async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (state !== "idle") return { ok: true };
    const support = recorderSupport();
    if (!support.recorder && !support.recognition) {
      return { ok: false, message: support.secure ? "This browser cannot record audio. Update it, or type your message." : "Voice recording needs a secure (HTTPS) connection." };
    }
    discardRef.current = false;
    endedRef.current = null;
    chunksRef.current = [];
    levelsRef.current = [];
    heardRef.current = { final: "", interim: "" };
    accumulatedRef.current = 0;
    segmentRef.current = null;
    setElapsedMs(0);

    if (!support.recorder) {
      const lang = !optionsRef.current.language || optionsRef.current.language === "auto" ? (navigator.language || "en-US") : optionsRef.current.language;
      if (!startRecognition(lang)) return { ok: false, message: "Voice input is not supported by this browser." };
      setHasWaveform(false);
      segmentRef.current = performance.now();
      startClock();
      setGlobalRecording(true);
      setState("recording");
      return { ok: true };
    }

    setState("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      setState("idle");
      const name = error instanceof Error ? error.name : "unknown";
      return { ok: false, message: name === "SecurityError" ? "The microphone is blocked on this page. Open MATRIX over HTTPS and allow microphone access." : voiceErrorMessage(name) };
    }
    try {
      streamRef.current = stream;
      const mimeType = pickRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      setHasWaveform(true);

      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        endedRef.current = "error";
        if (recorder.state !== "inactive") recorder.stop();
      };
      recorder.onstop = () => {
        const durationMs = Math.round(Math.min(elapsed(), MAX_RECORDING_MS));
        const type = recorder.mimeType || mimeType || "audio/webm";
        const levels = levelsRef.current;
        const chunks = chunksRef.current;
        const ended = endedRef.current;
        recorderRef.current = null;
        chunksRef.current = [];
        release();
        setState("idle");
        const resolve = resolveRef.current;
        resolveRef.current = null;
        if (discardRef.current) { resolve?.(null); return; }
        const heard = mergeTranscript(heardRef.current.final, heardRef.current.interim).trim();
        const deliver = (capture: VoiceCapture | null) => {
          if (resolve) resolve(capture);
          else optionsRef.current.onAutoStop?.(capture, ended === "limit" ? "limit" : "device");
        };
        const raw = new Blob(chunks, { type });
        if (!raw.size || ended === "error") { deliver(null); return; }
        void raw.slice(0, 16).arrayBuffer()
          .then((buffer) => sniffAudioMime(new Uint8Array(buffer)))
          .catch(() => null)
          .then((sniffed) => {
            // Keep the codec parameter when the container agrees with it.
            const mime = sniffed && !type.toLowerCase().startsWith(sniffed) ? sniffed : type;
            const blob = mime === type ? raw : new Blob(chunks, { type: mime });
            deliver({ kind: "clip", clip: { blob, url: URL.createObjectURL(blob), filename: `voice-${Date.now()}.${extensionForMime(mime)}`, mimeType: mime, durationMs, waveform: summarizeWaveform(levels), heard } });
          });
      };
      // Losing the microphone (unplugged, revoked, phone call) ends the
      // recording with whatever was captured instead of hanging forever.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (recorder.state === "inactive") return;
          endedRef.current ??= "device";
          recorder.stop();
        };
      });

      recorder.start(1000);
      segmentRef.current = performance.now();
      startClock();
      startMeter(stream, recorder);
      setGlobalRecording(true);
      // Where the browser can recognise speech next to the recorder (desktop,
      // a specific language), keep what it hears as a fallback transcript.
      const language = optionsRef.current.language ?? "auto";
      const plan = chooseVoiceEngine(language, {
        speechRecognition: support.recognition, mediaRecorder: true,
        mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), online: navigator.onLine !== false,
      });
      if (plan.live) startRecognition(language);
      // Keep the screen awake on phones while the user is speaking.
      const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      void wakeLock?.request("screen").then((lock) => { if (recorderRef.current === recorder) wakeLockRef.current = lock; else void lock.release().catch(() => {}); }).catch(() => {});
      setState("recording");
      return { ok: true };
    } catch {
      recorderRef.current = null;
      release();
      setState("idle");
      return { ok: false, message: "The browser could not start recording. Check the microphone and try again." };
    }
  }, [state, elapsed, release, setGlobalRecording, startClock, startMeter, startRecognition]);

  const stop = useCallback((): Promise<VoiceCapture | null> => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      return new Promise((resolve) => {
        resolveRef.current = resolve;
        // Freeze the clock at the moment Stop was pressed.
        accumulatedRef.current = elapsed();
        segmentRef.current = null;
        try { recorder.stop(); } catch { resolveRef.current = null; release(); setState("idle"); resolve(null); }
      });
    }
    if (recognitionRef.current) {
      const durationMs = Math.round(elapsed());
      const text = mergeTranscript(heardRef.current.final, heardRef.current.interim).trim();
      release();
      setState("idle");
      return Promise.resolve(text ? { kind: "transcript", text, durationMs } : null);
    }
    release();
    setState("idle");
    return Promise.resolve(null);
  }, [elapsed, release]);

  const cancel = useCallback(() => {
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* fall through to release */ }
    } else {
      recorderRef.current = null;
      release();
      setState("idle");
    }
    setElapsedMs(0);
  }, [release]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    try { recorder.pause(); } catch { return; }
    accumulatedRef.current = elapsed();
    segmentRef.current = null;
    setElapsedMs(accumulatedRef.current);
    if (recognitionRef.current) { recognitionWantedRef.current = false; try { recognitionRef.current.stop(); } catch { /* idle */ } }
    setState("paused");
  }, [elapsed]);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    try { recorder.resume(); } catch { return; }
    segmentRef.current = performance.now();
    if (recognitionRef.current) { recognitionWantedRef.current = true; try { recognitionRef.current.start(); } catch { /* already listening */ } }
    setState("recording");
  }, []);

  return { state, elapsedMs, hasWaveform, canvasRef, start, stop, cancel, pause, resume };
}
