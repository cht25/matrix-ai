"use client";

// =============================================================================
// QORVYNA floating assistant (popup shell)
//
// This is the surface the desktop `assistant` window loads
// (`index.html?window=assistant`) when Ctrl+Shift+Space is pressed, and the
// screen the Android bubble/assist intent opens. It is NOT a second app:
//
//   • it ships inside the same bundle as the full app (public/native);
//   • it uses the same theme, the same auth session and the same /api/ai;
//   • it calls the same Rust commands the main window calls.
//
// Behaviour, in the order it happens:
//   1. window opens → microphone capture starts straight away (one click on the
//      hotkey = one turn, like a system assistant);
//   2. waveform + duration while recording, stop → transcribe;
//   3. the transcript is sent ONCE to the chat endpoint and the reply is shown
//      and spoken;
//   4. failures keep the recording and offer Retry; nothing is sent twice;
//   5. "Open QORVYNA" hands the turn to the full app window.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, Square, X } from "lucide-react";
import { optionalAuthHeaders } from "@/lib/client/api";
import { VoiceTranscribing } from "@/components/voice-composer";
import { useVoiceRecorder, type VoiceCapture, type VoiceClip } from "@/lib/client/use-voice-recorder";
import { createVoiceTurnLedger, formatClock, mergeTranscript, voiceErrorMessage } from "@/lib/voice-input";

type Phase = "listening" | "thinking" | "answering" | "error";

type Reply = { role: "user" | "assistant"; text: string };

function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, a?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) return Promise.resolve(null);
  return internals.invoke(command, args).then((value) => value as T).catch(() => null);
}

export function AssistantPopup() {
  const [phase, setPhase] = useState<Phase>("listening");
  const [thread, setThread] = useState<Reply[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryClip, setRetryClip] = useState<VoiceClip | null>(null);
  const recorder = useVoiceRecorder({ onAutoStop: (capture) => handleCapture(capture) });
  const ledger = useRef(createVoiceTurnLedger());
  const turnRef = useRef(0);
  const startedRef = useRef(false);

  const speak = useCallback((text: string) => {
    try {
      if (!text.trim() || !("speechSynthesis" in window)) return;
      const utterance = new SpeechSynthesisUtterance(text.slice(0, 600));
      utterance.rate = 1.02;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      /* speech is optional */
    }
  }, []);

  /** One transcript → one request. The ledger makes a second dispatch impossible. */
  const submit = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      const turnId = `${Date.now()}-${turnRef.current++}`;
      if (!ledger.current.claim(turnId)) return;
      setThread((current) => [...current, { role: "user", text: clean }]);
      setPhase("thinking");
      setNotice(null);
      try {
        const authHeaders = await optionalAuthHeaders();
        const response = await fetch("/api/ai", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            action: "chat",
            message: clean,
            mode: "chat",
            stream: false,
            is_temporary: false,
            input_source: "voice",
            request_id: turnId,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { reply?: string; error?: string; detail?: string };
        if (!response.ok || !data.reply) {
          ledger.current.release(turnId);
          const reason = data.error === "UNAUTHENTICATED"
            ? "Sign in to the full app once, then this popup can answer."
            : data.detail || data.error || `The assistant could not answer (${response.status}).`;
          setPhase("error");
          setNotice(reason);
          return;
        }
        setThread((current) => [...current, { role: "assistant", text: data.reply as string }]);
        setPhase("answering");
        speak(data.reply);
      } catch {
        ledger.current.release(turnId);
        setPhase("error");
        setNotice(navigator.onLine === false ? "You are offline. Reconnect and try again." : "QORVYNA could not be reached. Your words are kept below.");
      }
    },
    [speak],
  );

  const transcribe = useCallback(
    async (clip: VoiceClip) => {
      try {
        const form = new FormData();
        form.append("audio", clip.blob, clip.filename);
        form.append("duration_ms", String(clip.durationMs));
        form.append("language", "auto");
        form.append("store", "0");
        const response = await fetch("/api/voice/transcribe", {
          method: "POST",
          credentials: "same-origin",
          headers: await optionalAuthHeaders(),
          body: form,
        });
        const data = (await response.json().catch(() => ({}))) as { transcript?: string; error?: string };
        const transcript = String(data.transcript ?? "").trim();
        if (!response.ok || !transcript) {
          // The recording is kept: Retry is offered, nothing is lost.
          setRetryClip(clip);
          setPhase("error");
          setNotice(voiceErrorMessage(String(data.error ?? response.status)));
          return;
        }
        setRetryClip(null);
        await submit(transcript);
      } catch {
        setRetryClip(clip);
        setPhase("error");
        setNotice("The recording could not be transcribed. Retry keeps it.");
      }
    },
    [submit],
  );

  const handleCapture = useCallback(
    (capture: VoiceCapture | null) => {
      if (!capture) {
        setPhase("error");
        setNotice("No audio was captured. Check the microphone and try again.");
        return;
      }
      if (capture.kind === "transcript") {
        void submit(capture.text);
        return;
      }
      void transcribe(capture.clip);
    },
    [submit, transcribe],
  );

  const startListening = useCallback(async () => {
    if (recorder.state !== "idle") return;
    setPhase("listening");
    setNotice(null);
    const started = await recorder.start();
    if (!started.ok) {
      setPhase("error");
      setNotice(started.message);
    }
  }, [recorder]);

  // One hotkey press = one turn: start capturing as soon as the window loads.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rust re-emits this every time the window is shown/shown again, so a
  // second Ctrl+Shift+Space starts a new turn without reopening the window.
  const startRef = useRef(startListening);
  startRef.current = startListening;
  useEffect(() => {
    const listen = (window as unknown as { __TAURI__?: { event?: { listen?: (event: string, cb: () => void) => Promise<() => void> } } }).__TAURI__?.event?.listen;
    if (!listen) return undefined;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen("qorvyna://voice-activate", () => {
      if (disposed) return;
      setThread([]);
      setNotice(null);
      void startRef.current();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const close = useCallback(() => {
    // Closing must release the microphone, not leave it open in a hidden window.
    void recorder.cancel();
    void tauriInvoke("qorvyna_assistant_popup", { action: "hide" });
  }, [recorder]);

  const openFullApp = useCallback(() => {
    void tauriInvoke("qorvyna_assistant_open_main", {});
  }, []);

  const recording = recorder.state === "recording" || recorder.state === "requesting" || recorder.state === "paused";
  const transcribing = phase === "thinking" && !recording;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-ink">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2" data-tauri-drag-region>
        <span className="flex items-center gap-2 text-[12.5px] font-semibold">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-accent-solid text-[10px] font-bold text-accent-ink" aria-hidden="true">Q</span>
          QORVYNA Assistant
        </span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={openFullApp} className="rounded-md px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            Open app
          </button>
          <button type="button" onClick={close} aria-label="Close assistant" className="grid h-8 w-8 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {thread.length === 0 ? (
          <p className="mt-2 text-[12.5px] leading-snug text-ink-3">
            Say what you need — QORVYNA transcribes it and sends it once. Ask a question, or ask it to build something and
            it will hand the request to the full app.
          </p>
        ) : (
          <ul className="grid gap-2">
            {thread.map((entry, index) => (
              <li
                key={index}
                className={
                  entry.role === "user"
                    ? "ml-auto max-w-[90%] rounded-2xl bg-accent-soft px-3 py-2 text-[12.5px] text-ink"
                    : "mr-auto max-w-[95%] whitespace-pre-wrap rounded-2xl border border-border bg-surface px-3 py-2 text-[12.5px] leading-snug text-ink"
                }
                dir="auto"
              >
                {entry.text}
              </li>
            ))}
          </ul>
        )}

        {transcribing ? <VoiceTranscribing onCancel={() => setPhase("listening")} /> : null}

        {notice ? (
          <div className="mt-2 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-2 text-[12px] text-danger" role="alert">
            {notice}
            {retryClip ? (
              <button
                type="button"
                onClick={() => {
                  const clip = retryClip;
                  setRetryClip(null);
                  setNotice(null);
                  void transcribe(clip);
                }}
                className="ml-2 rounded-md border border-danger/40 px-2 py-0.5 text-[11.5px] font-semibold"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="border-t border-border px-3 py-2.5">
        {recording ? (
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-danger pulse-dot" aria-hidden="true" />
            <span className="font-mono text-[12.5px] tabular-nums text-ink">{formatClock(recorder.elapsedMs / 1000)}</span>
            {recorder.hasWaveform ? (
              <canvas ref={recorder.canvasRef} aria-label="Live microphone level" role="img" className="h-7 min-w-0 flex-1 text-danger" />
            ) : (
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3">Listening…</span>
            )}
            <button type="button" onClick={recorder.cancel} aria-label="Discard recording" className="grid h-9 w-9 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink">
              <X size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => void recorder.stop()}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent-solid px-3 text-[12.5px] font-semibold text-accent-ink"
            >
              <Square size={11} fill="currentColor" aria-hidden="true" /> Send
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void startListening()}
              disabled={phase === "thinking"}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-full border border-border text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
            >
              {phase === "thinking" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
              {phase === "thinking" ? "Thinking…" : "Speak again"}
            </button>
            <button
              type="button"
              onClick={openFullApp}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12px] font-medium text-ink hover:bg-surface-3"
            >
              <ArrowUp size={13} aria-hidden="true" /> Full app
            </button>
          </div>
        )}
        <p className="mt-1.5 text-center text-[10.5px] text-ink-3">
          {recorder.hasWaveform ? "Audio never leaves the device until you stop." : "Microphone is captured only while you hold this turn."}
        </p>
      </footer>
    </div>
  );
}

export default AssistantPopup;

/** The popup route is selected by the URL Tauri opens for the window. */
export function isAssistantWindow(search: string): boolean {
  try {
    return new URLSearchParams(search).get("window") === "assistant";
  } catch {
    return false;
  }
}

/** Reusable by tests: the exact text sent for one assistant turn. */
export function assistantTurnPrompt(transcript: string, typed?: string): string {
  return mergeTranscript(typed ?? "", transcript).trim();
}
