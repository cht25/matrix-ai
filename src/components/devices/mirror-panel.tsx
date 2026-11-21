"use client";

// =============================================================================
// Multi-Device Real-Time Screen Mirroring & Consent-Based Viewing (WebRTC)
// Aligned 1:1 with server contracts in src/lib/server/mirror-webrtc.ts
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cast, Check, Eye, Lock, Monitor, MousePointer, RefreshCw, ShieldAlert, Square, VideoOff, X,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { rpc, RpcCallError } from "@/lib/client/api";
import type { HubDevice } from "@/lib/devices/model";

type MirrorSession = {
  session_id: string;
  source_device_id: string;
  source_device_name: string;
  viewer_device_id: string;
  status: "awaiting_source_consent" | "active" | "denied" | "ended" | "expired";
  mode: "view_only" | "remote_control";
  remote_control_requested: boolean;
  remote_control_enabled: boolean;
  started_at: string;
  expires_at: string;
};

type MirrorSignal = {
  id: string;
  from_role: "viewer" | "source";
  kind: "offer" | "answer" | "ice" | "snapshot" | "remote_command";
  payload: Record<string, unknown>;
  created_at_ms: number;
};

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function MirrorPanel() {
  const [devices, setDevices] = useState<HubDevice[]>([]);
  const [sessions, setSessions] = useState<MirrorSession[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [requestRemoteControl, setRequestRemoteControl] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<"source" | "viewer" | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const lastSignalMsRef = useRef<number>(0);
  const seenSignalIdsRef = useRef<Set<string>>(new Set());
  const loadErrorActiveRef = useRef<boolean>(false);

  const cleanupRtc = useCallback(() => {
    try {
      pcRef.current?.close();
    } catch {
      /* ignore */
    }
    pcRef.current = null;
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setSnapshotUrl(null);
    lastSignalMsRef.current = 0;
    seenSignalIdsRef.current.clear();
  }, []);

  useEffect(() => () => cleanupRtc(), [cleanupRtc]);

  const loadState = useCallback(async () => {
    try {
      const [devList, sessRes] = await Promise.all([
        rpc<HubDevice[]>("device_list"),
        rpc<{ sessions: MirrorSession[] } | MirrorSession[]>("mirror_sessions_list"),
      ]);
      const activeDevs = (Array.isArray(devList) ? devList : []).filter((d) => d.status !== "revoked");
      const nextSessions = Array.isArray(sessRes) ? sessRes : (sessRes?.sessions ?? []);
      setDevices(activeDevs);
      setSessions(nextSessions);
      setSourceId((prev) => (prev && activeDevs.some((d) => d.id === prev) ? prev : activeDevs[0]?.id || ""));
      if (loadErrorActiveRef.current) {
        loadErrorActiveRef.current = false;
        setError("");
      }
    } catch (err) {
      loadErrorActiveRef.current = true;
      if (err instanceof RpcCallError) {
        setError(err.requestId ? `${err.code} (ref: ${err.requestId})` : err.code);
      } else {
        setError("Could not load devices and mirror sessions.");
      }
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadState();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadState]);

  const currentSession = sessions.find((s) => s.session_id === activeSessionId) ?? null;

  async function startViewerSession() {
    if (!sourceId) return;
    setBusy("create");
    setError("");
    setNotice("");
    cleanupRtc();
    try {
      const session = await rpc<MirrorSession>("mirror_session_create", {
        source_device_id: sourceId,
        remote_control_requested: requestRemoteControl,
        ttl_minutes: 15,
      });
      setActiveSessionId(session.session_id);
      setActiveRole("viewer");
      setNotice(`Mirror request sent to ${session.source_device_name}. Waiting for explicit consent on the source device.`);
      await loadState();
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not request screen mirror.");
    } finally {
      setBusy("");
    }
  }

  async function respondConsent(session: MirrorSession, accept: boolean, allowRemote: boolean) {
    setBusy(`consent:${session.session_id}`);
    setError("");
    setNotice("");
    try {
      if (!accept) {
        await rpc("mirror_session_respond", { session_id: session.session_id, accept: false });
        setNotice("Mirror request declined.");
        await loadState();
        return;
      }

      if (!navigator.mediaDevices?.getDisplayMedia) {
        setError("This browser does not support screen capture (getDisplayMedia). Use Desktop or Android device sharing.");
        return;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 24, max: 30 } },
        audio: false,
      });
      cleanupRtc();
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      await rpc("mirror_session_respond", {
        session_id: session.session_id,
        accept: true,
        allow_remote_control: allowRemote,
      });

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
        track.onended = () => {
          void stopMirror(session.session_id, "source_track_ended");
        };
      }
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          void rpc("mirror_session_signal", {
            session_id: session.session_id,
            from_role: "source",
            kind: "ice",
            payload: ev.candidate.toJSON() as unknown as Record<string, unknown>,
          }).catch(() => {});
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await rpc("mirror_session_signal", {
        session_id: session.session_id,
        from_role: "source",
        kind: "offer",
        payload: { sdp: offer.sdp, type: offer.type },
      });

      setActiveSessionId(session.session_id);
      setActiveRole("source");
      setNotice(`Live screen sharing active (${allowRemote ? "remote control enabled" : "view-only"}).`);
      await loadState();
    } catch (err) {
      cleanupRtc();
      setError(err instanceof Error ? err.message : "Screen sharing permission was cancelled or denied.");
    } finally {
      setBusy("");
    }
  }

  async function stopMirror(sessionId: string, reason = "user_stopped") {
    setBusy(`stop:${sessionId}`);
    try {
      await rpc("mirror_session_stop", { session_id: sessionId, reason });
    } catch {
      /* ignore already ended */
    }
    if (activeSessionId === sessionId) {
      cleanupRtc();
      setActiveSessionId(null);
      setActiveRole(null);
    }
    setNotice("Screen mirror session stopped.");
    setBusy("");
    await loadState();
  }

  useEffect(() => {
    if (!activeSessionId || !activeRole || !currentSession) return;
    if (currentSession.status === "ended" || currentSession.status === "denied" || currentSession.status === "expired") {
      cleanupRtc();
      setActiveSessionId(null);
      setActiveRole(null);
      setNotice(`Mirror session ended (${currentSession.status}).`);
      return;
    }
    if (currentSession.status !== "active") return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await rpc<{ signals: MirrorSignal[] }>("mirror_session_signals", {
          session_id: activeSessionId,
          after_ms: lastSignalMsRef.current,
        });
        for (const sig of res.signals ?? []) {
          if (cancelled || seenSignalIdsRef.current.has(sig.id)) continue;
          seenSignalIdsRef.current.add(sig.id);
          if (sig.created_at_ms > lastSignalMsRef.current) lastSignalMsRef.current = sig.created_at_ms;

          if (activeRole === "viewer" && sig.from_role === "source") {
            if (sig.kind === "snapshot" && typeof sig.payload.data_url === "string") {
              setSnapshotUrl(sig.payload.data_url);
              continue;
            }
            if (sig.kind === "offer" && typeof sig.payload.sdp === "string") {
              if (!pcRef.current) {
                const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
                pcRef.current = pc;
                pc.ontrack = (ev) => {
                  if (remoteVideoRef.current && ev.streams[0]) {
                    remoteVideoRef.current.srcObject = ev.streams[0];
                  }
                };
                pc.onicecandidate = (ev) => {
                  if (ev.candidate) {
                    void rpc("mirror_session_signal", {
                      session_id: activeSessionId,
                      from_role: "viewer",
                      kind: "ice",
                      payload: ev.candidate.toJSON() as unknown as Record<string, unknown>,
                    }).catch(() => {});
                  }
                };
              }
              await pcRef.current.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sig.payload.sdp }));
              const answer = await pcRef.current.createAnswer();
              await pcRef.current.setLocalDescription(answer);
              await rpc("mirror_session_signal", {
                session_id: activeSessionId,
                from_role: "viewer",
                kind: "answer",
                payload: { type: answer.type, sdp: answer.sdp },
              });
            } else if (sig.kind === "ice" && pcRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(sig.payload as RTCIceCandidateInit)).catch(() => {});
            }
          } else if (activeRole === "source" && sig.from_role === "viewer") {
            if (sig.kind === "answer" && typeof sig.payload.sdp === "string" && pcRef.current) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sig.payload.sdp }));
            } else if (sig.kind === "ice" && pcRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(sig.payload as RTCIceCandidateInit)).catch(() => {});
            }
          }
        }
      } catch {
        /* ignore transient signaling poll errors */
      }
    };

    void poll();
    const id = window.setInterval(() => {
      if (!cancelled) void poll();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeSessionId, activeRole, currentSession, cleanupRtc]);

  const pendingConsents = sessions.filter((s) => s.status === "awaiting_source_consent");
  const activeSessions = sessions.filter((s) => s.status === "active");

  return (
    <div className="space-y-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Cast size={18} className="text-accent" />
              <h2 className="font-semibold text-ink">Start Live Screen Mirror (WebRTC)</h2>
            </div>
            <p className="mt-1 text-xs text-ink-3">
              View-only by default. Streaming begins ONLY after explicit confirmation on the source device (max 15 minutes per session).
            </p>
          </div>
          <Button variant="secondary" className="!min-h-8 !px-3 !text-xs" onClick={() => void loadState()}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>

        {devices.length === 0 ? (
          <EmptyState
            icon={<Monitor size={20} />}
            title="No paired devices yet"
            body="Pair two or more devices under Devices first, then pick a source device to mirror."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-ink-2">Source device to view</label>
              <select
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink"
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.device_name} ({d.platform} · {d.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={requestRemoteControl}
                  onChange={(e) => setRequestRemoteControl(e.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                Request remote control (requires extra source consent &amp; scope)
              </label>
              <Button disabled={busy === "create" || !sourceId} onClick={() => void startViewerSession()}>
                <Cast size={15} /> Request screen mirror
              </Button>
            </div>
          </div>
        )}
      </Card>

      {pendingConsents.length > 0 ? (
        <Card className="space-y-3 border-warning/40">
          <div className="flex items-center gap-2 text-warning">
            <ShieldAlert size={18} />
            <h3 className="font-semibold text-ink">Incoming Mirror Consent Requests</h3>
          </div>
          <ul className="space-y-2.5">
            {pendingConsents.map((s) => (
              <li key={s.session_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/50 p-3 text-xs">
                <div>
                  <p className="font-medium text-ink">
                    Request to view <strong>{s.source_device_name}</strong>
                  </p>
                  <p className="text-ink-3">
                    Requested mode: {s.remote_control_requested ? "View + optional remote control" : "View-only"} · Expires {new Date(s.expires_at).toLocaleTimeString()}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" className="!min-h-8 !px-3 !text-xs" disabled={busy === `consent:${s.session_id}`} onClick={() => void respondConsent(s, false, false)}>
                    <X size={13} /> Decline
                  </Button>
                  <Button variant="secondary" className="!min-h-8 !px-3 !text-xs" disabled={busy === `consent:${s.session_id}`} onClick={() => void respondConsent(s, true, false)}>
                    <Eye size={13} /> Share View-Only
                  </Button>
                  {s.remote_control_requested ? (
                    <Button className="!min-h-8 !px-3 !text-xs" disabled={busy === `consent:${s.session_id}`} onClick={() => void respondConsent(s, true, true)}>
                      <MousePointer size={13} /> Share + Control
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {activeSessionId && currentSession?.status === "active" ? (
        <Card className="space-y-3 border-accent/40">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
              <h3 className="font-semibold text-ink">
                {activeRole === "source" ? "Broadcasting Your Screen" : `Viewing ${currentSession.source_device_name}`}
              </h3>
              <Badge>
                <Lock size={11} /> {currentSession.remote_control_enabled ? "Remote control active" : "View-only"}
              </Badge>
            </div>
            <Button variant="danger" className="!min-h-8 !px-3 !text-xs" onClick={() => void stopMirror(currentSession.session_id)}>
              <Square size={13} /> Stop sharing immediately
            </Button>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-black">
            {activeRole === "source" ? (
              <video ref={localVideoRef} autoPlay muted playsInline className="max-h-[420px] w-full object-contain" />
            ) : snapshotUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={snapshotUrl} alt="Mirrored mobile frame" className="max-h-[540px] w-full object-contain" />
            ) : (
              <video ref={remoteVideoRef} autoPlay playsInline className="max-h-[540px] w-full object-contain" />
            )}
          </div>
        </Card>
      ) : null}

      {activeSessions.length > 0 && !activeSessionId ? (
        <Card className="space-y-2.5">
          <h3 className="font-semibold text-ink">Active Mirror Sessions</h3>
          <ul className="space-y-2">
            {activeSessions.map((s) => (
              <li key={s.session_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/40 p-3 text-xs">
                <div>
                  <p className="font-medium text-ink">{s.source_device_name}</p>
                  <p className="text-ink-3">{s.mode} · expires {new Date(s.expires_at).toLocaleTimeString()}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="!min-h-8 !px-3 !text-xs"
                    onClick={() => {
                      cleanupRtc();
                      setActiveSessionId(s.session_id);
                      setActiveRole("viewer");
                    }}
                  >
                    <Check size={13} /> Open viewer
                  </Button>
                  <Button variant="danger" className="!min-h-8 !px-3 !text-xs" onClick={() => void stopMirror(s.session_id)}>
                    <VideoOff size={13} /> Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
