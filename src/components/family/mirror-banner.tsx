"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Eye, Lock, ShieldOff, StopCircle } from "lucide-react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { useToast } from "@/components/toast";
import { isTauriApp, notifyWorkDone } from "@/lib/client/work-notifications";

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof RpcCallError) return err.code.replace(/_/g, " ").toLowerCase();
  return fallback;
}

type ActiveMirrorSession = {
  session_id: string;
  family_id: string;
  family_name: string;
  viewer_name: string;
  started_at: string;
  expires_at: string;
  frames: number;
};

type MirrorAndLockState = {
  active_sessions: ActiveMirrorSession[];
  locked: { family_id: string; family_name: string; reason: string } | null;
};

export function MirrorAndLockBanner() {
  const toast = useToast();
  const [state, setState] = useState<MirrorAndLockState>({ active_sessions: [], locked: null });
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestNote, setRequestNote] = useState("");
  const [requested, setRequested] = useState(false);
  const seenSessionsRef = useRef<Set<string>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const frameTimerRef = useRef<number | null>(null);

  const stopLocalCapture = useCallback(() => {
    if (frameTimerRef.current !== null) {
      window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setSharing(false);
  }, []);

  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const next = await rpc<MirrorAndLockState>("family_mirror_active");
      setState(next);
      for (const s of next.active_sessions) {
        if (!seenSessionsRef.current.has(s.session_id)) {
          seenSessionsRef.current.add(s.session_id);
          void notifyWorkDone({
            title: "Family screen mirroring active",
            body: `${s.viewer_name} (${s.family_name}) started viewing this device's screen.`,
            link: "/family",
            refreshBell: true,
          });
        }
      }
      if (next.active_sessions.length === 0) {
        stopLocalCapture();
      }
    } catch {
      // Ignore transient network hiccups.
    }
  }, [stopLocalCapture]);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), 7_000);
    return () => {
      window.clearInterval(timer);
      stopLocalCapture();
    };
  }, [poll, stopLocalCapture]);

  async function startScreenShare(sessionId: string) {
    if (sharing) return;
    try {
      // On Tauri desktop, attempt native screen capture command first if exposed.
      if (isTauriApp()) {
        const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string) => Promise<string> } }).__TAURI_INTERNALS__?.invoke;
        if (typeof invoke === "function") {
          try {
            const dataUrl = await invoke("matrix_capture_screen");
            if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
              await rpc("family_mirror_frame_upload", { session_id: sessionId, image_data_url: dataUrl });
              setSharing(true);
              frameTimerRef.current = window.setInterval(async () => {
                try {
                  const frame = await invoke("matrix_capture_screen");
                  if (typeof frame === "string" && frame.startsWith("data:image/")) {
                    await rpc("family_mirror_frame_upload", { session_id: sessionId, image_data_url: frame });
                  }
                } catch {
                  stopLocalCapture();
                }
              }, 4_500);
              return;
            }
          } catch {
            // Fall through to standard Web DisplayMedia.
          }
        }
      }

      if (!navigator.mediaDevices?.getDisplayMedia) {
        toast("Screen capture is not supported in this browser.");
        return;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 2, max: 5 } },
        audio: false,
      });
      streamRef.current = stream;
      setSharing(true);

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();

      const sendFrame = async () => {
        if (!streamRef.current || video.videoWidth === 0) return;
        const maxW = 1280;
        const scale = Math.min(1, maxW / video.videoWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
        await rpc("family_mirror_frame_upload", { session_id: sessionId, image_data_url: dataUrl });
      };

      stream.getVideoTracks()[0]?.addEventListener("ended", () => stopLocalCapture());
      window.setTimeout(() => void sendFrame().catch(() => {}), 450);
      frameTimerRef.current = window.setInterval(() => {
        void sendFrame().catch(() => stopLocalCapture());
      }, 4_500);
    } catch (e) {
      stopLocalCapture();
      toast(friendlyError(e, "Screen share cancelled."));
    }
  }

  async function stopSession(sessionId: string) {
    setBusy(true);
    try {
      stopLocalCapture();
      await rpc("family_mirror_stop", { session_id: sessionId });
      await poll();
      toast("Screen mirroring stopped.");
    } catch (e) {
      toast(friendlyError(e, "Could not stop mirroring."));
    } finally {
      setBusy(false);
    }
  }

  async function disableMirroring(familyId: string) {
    setBusy(true);
    try {
      stopLocalCapture();
      await rpc("family_mirror_consent", { family_id: familyId, consent: "revoke" });
      await poll();
      toast("Mirroring disabled. A parent must re-grant access before it can be turned back on.");
    } catch (e) {
      toast(friendlyError(e, "Could not disable mirroring."));
    } finally {
      setBusy(false);
    }
  }

  async function askParentUnlock(familyId: string) {
    setBusy(true);
    try {
      await rpc("family_request_parent_access", {
        family_id: familyId,
        kind: "unlock_device",
        note: requestNote.trim() || undefined,
      });
      setRequested(true);
      setRequestNote("");
      toast("Request sent to your parent(s).");
    } catch (e) {
      toast(friendlyError(e, "Could not send request."));
    } finally {
      setBusy(false);
    }
  }

  const active = state.active_sessions[0];

  return (
    <>
      {active ? (
        <div
          role="status"
          aria-live="polite"
          className="sticky top-0 z-40 border-b border-warn/40 bg-warn-soft/95 px-4 py-2.5 backdrop-blur-md"
        >
          <div className="mx-auto flex max-w-[var(--content-max)] flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 text-ink">
              <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-warn" />
              <Eye size={15} className="shrink-0 text-warn" />
              <span>
                <strong>Family screen mirroring is active:</strong> {active.viewer_name} ({active.family_name}) is viewing this device.
                {sharing ? " Streaming live screenshots." : ""}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {!sharing ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void startScreenShare(active.session_id)}
                  className="btn-primary !min-h-0 !px-2.5 !py-1.5 !text-xs"
                >
                  <Camera size={13} /> Share screen (ss)
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void stopSession(active.session_id)}
                className="btn-ghost !min-h-0 !px-2.5 !py-1.5 !text-xs"
              >
                <StopCircle size={13} /> Stop session
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void disableMirroring(active.family_id)}
                className="btn-danger !min-h-0 !px-2.5 !py-1.5 !text-xs"
              >
                <ShieldOff size={13} /> Disable mirroring
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {state.locked ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Device paused by family"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-bg/95 p-4 backdrop-blur-lg"
        >
          <div className="card w-full max-w-md space-y-4 !p-6 text-center shadow-[var(--shadow-pop)]">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-warn-soft text-warn">
              <Lock size={26} />
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-warn">
                {state.locked.family_name} · Family Supervision
              </p>
              <h2 className="text-xl font-semibold text-ink">Time for a break</h2>
              <p className="text-sm text-ink-2">{state.locked.reason}</p>
            </div>

            {requested ? (
              <p className="rounded-xl border border-accent/30 bg-accent-soft/20 px-3 py-2.5 text-xs text-ink">
                Your parent has been notified. This screen unlocks automatically as soon as they grant access.
              </p>
            ) : (
              <div className="space-y-2 text-left">
                <input
                  value={requestNote}
                  onChange={(e) => setRequestNote(e.target.value)}
                  maxLength={180}
                  placeholder="Optional note for your parent (e.g. Homework due tonight)…"
                  className="input !text-xs"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => state.locked && void askParentUnlock(state.locked.family_id)}
                  className="btn-primary w-full justify-center"
                >
                  Ask parent to unlock
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
