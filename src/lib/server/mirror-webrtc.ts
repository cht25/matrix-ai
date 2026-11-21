// =============================================================================
// QORVYNA AI — Multi-Device WebRTC Screen Mirroring & Secure Signaling.
//
// Security rules:
//   - View-only by default. Remote control is ALWAYS disabled unless requested
//     AND explicitly approved per-session by the source device.
//   - Explicit source permission required before any stream/signaling starts.
//   - Short session TTL (1..15 minutes), instant stop by either side.
//   - Zero covert capture, zero silent remote control.
// =============================================================================

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { safeIso, safeMillis } from "@/lib/server/sort";

const SESSIONS = "mirror_sessions";
const DEVICES = "devices";
const DEFAULT_TTL_MINUTES = 15;

export type MirrorSessionStatus = "awaiting_source_consent" | "active" | "denied" | "ended" | "expired";

export type MirrorSessionView = {
  session_id: string;
  owner_uid: string;
  source_device_id: string;
  source_device_name: string;
  viewer_device_id: string;
  viewer_device_name: string;
  status: MirrorSessionStatus;
  mode: "view_only" | "remote_control";
  remote_control_requested: boolean;
  remote_control_enabled: boolean;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_reason: string | null;
};

const millis = (v: unknown): number => safeMillis(v);
const iso = (v: unknown): string => safeIso(v);
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

async function audit(d: Db, uid: string, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
  try {
    await d.collection("audit_logs").add({
      actor_id: uid,
      action,
      target_type: "mirror_session",
      target_id: targetId,
      reason: "",
      metadata,
      created_at: nowTs(),
    });
  } catch {
    /* best effort */
  }
}

function toView(id: string, data: Record<string, unknown>, nowMs = Date.now()): MirrorSessionView {
  let status = String(data.status ?? "ended") as MirrorSessionStatus;
  if ((status === "awaiting_source_consent" || status === "active") && millis(data.expires_at) <= nowMs) {
    status = "expired";
  }
  const remoteEnabled = status === "active" && data.remote_control_enabled === true;
  return {
    session_id: id,
    owner_uid: String(data.owner_uid ?? ""),
    source_device_id: String(data.source_device_id ?? ""),
    source_device_name: String(data.source_device_name ?? ""),
    viewer_device_id: String(data.viewer_device_id ?? ""),
    viewer_device_name: String(data.viewer_device_name ?? ""),
    status,
    mode: remoteEnabled ? "remote_control" : "view_only",
    remote_control_requested: data.remote_control_requested === true,
    remote_control_enabled: remoteEnabled,
    started_at: iso(data.created_at),
    expires_at: iso(data.expires_at),
    ended_at: data.ended_at ? iso(data.ended_at) : null,
    ended_reason: typeof data.ended_reason === "string" ? data.ended_reason : null,
  };
}

export async function createMirrorSession(
  d: Db,
  user: SessionUser,
  input: {
    source_device_id: string;
    viewer_device_id?: string;
    remote_control_requested?: boolean;
    ttl_minutes?: number;
  },
): Promise<MirrorSessionView> {
  if (user.deviceId) {
    const viewerSnap = await d.collection(DEVICES).doc(user.deviceId).get();
    const scopes = Array.isArray(viewerSnap.data()?.scopes) ? viewerSnap.data()!.scopes : [];
    if (!viewerSnap.exists || viewerSnap.data()?.revoked_at || viewerSnap.data()?.suspended_at || !scopes.includes("mirror:view")) {
      throw new RpcError("DEVICE_SCOPE_DENIED", 403);
    }
  }

  const srcSnap = await d.collection(DEVICES).doc(input.source_device_id).get();
  if (!srcSnap.exists || srcSnap.data()!.user_id !== user.uid || srcSnap.data()!.revoked_at || srcSnap.data()!.suspended_at) {
    throw new RpcError("DEVICE_NOT_AVAILABLE", 404);
  }

  let viewerName = "Web Viewer";
  const viewerId = user.deviceId ?? clean(input.viewer_device_id, 128) ?? "web";
  if (viewerId !== "web") {
    const vSnap = await d.collection(DEVICES).doc(viewerId).get();
    if (vSnap.exists && vSnap.data()!.user_id === user.uid) {
      viewerName = clean(vSnap.data()!.device_name, 80) || viewerName;
    }
  }

  const ttlMins = Math.max(1, Math.min(DEFAULT_TTL_MINUTES, Math.round(input.ttl_minutes ?? DEFAULT_TTL_MINUTES)));
  const expiresMs = Date.now() + ttlMins * 60_000;
  const ref = d.collection(SESSIONS).doc();
  const payload = {
    owner_uid: user.uid,
    source_device_id: srcSnap.id,
    source_device_name: clean(srcSnap.data()!.device_name, 80) || "Source device",
    viewer_device_id: viewerId,
    viewer_device_name: viewerName,
    status: "awaiting_source_consent",
    remote_control_requested: Boolean(input.remote_control_requested),
    // Remote control is NEVER active until the source device explicitly opts in.
    remote_control_enabled: false,
    expires_at: Timestamp.fromMillis(expiresMs),
    source_consented_at: null,
    ended_at: null,
    ended_reason: null,
    created_at: nowTs(),
  };
  await ref.set(payload);
  await audit(d, user.uid, "mirror.session_requested", ref.id, {
    source_device_id: srcSnap.id,
    remote_control_requested: payload.remote_control_requested,
  });
  return toView(ref.id, { ...payload, created_at: Timestamp.now() });
}

export async function respondMirrorConsent(
  d: Db,
  user: SessionUser,
  input: { session_id: string; accept: boolean; allow_remote_control?: boolean },
): Promise<MirrorSessionView> {
  const ref = d.collection(SESSIONS).doc(input.session_id);
  const nowMs = Date.now();
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
    const data = snap.data()!;
    if (data.owner_uid !== user.uid) throw new RpcError("PERMISSION_DENIED", 403);
    if (user.deviceId && user.deviceId !== data.source_device_id) {
      throw new RpcError("SOURCE_DEVICE_REQUIRED", 403);
    }
    if (data.status !== "awaiting_source_consent") throw new RpcError("MIRROR_SESSION_CLOSED", 409);
    if (millis(data.expires_at) <= nowMs) {
      tx.set(ref, { status: "expired", ended_at: nowTs(), ended_reason: "consent_timeout" }, { merge: true });
      throw new RpcError("MIRROR_SESSION_EXPIRED", 410);
    }
    if (!input.accept) {
      tx.set(ref, { status: "denied", remote_control_enabled: false, ended_at: nowTs(), ended_reason: "denied_by_source" }, { merge: true });
      return;
    }
    const allowRemote = Boolean(input.allow_remote_control && data.remote_control_requested);
    tx.set(
      ref,
      {
        status: "active",
        remote_control_enabled: allowRemote,
        source_consented_at: nowTs(),
      },
      { merge: true },
    );
  });

  await audit(d, user.uid, input.accept ? "mirror.consent_granted" : "mirror.consent_denied", input.session_id, {
    allow_remote_control: Boolean(input.allow_remote_control),
  });
  const updated = await ref.get();
  return toView(updated.id, updated.data()!);
}

export async function postMirrorSignal(
  d: Db,
  user: SessionUser,
  input: {
    session_id: string;
    from_role: "viewer" | "source";
    kind: "offer" | "answer" | "ice" | "snapshot" | "remote_command";
    payload: Record<string, unknown>;
  },
): Promise<{ signal_id: string }> {
  const ref = d.collection(SESSIONS).doc(input.session_id);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  if (data.owner_uid !== user.uid) throw new RpcError("PERMISSION_DENIED", 403);
  if (data.status !== "active" || millis(data.expires_at) <= Date.now()) {
    throw new RpcError("MIRROR_SESSION_NOT_ACTIVE", 409);
  }
  if (input.kind === "remote_command") {
    if (data.remote_control_enabled !== true) {
      throw new RpcError("REMOTE_CONTROL_DISABLED", 403);
    }
    if (user.deviceId) {
      const vSnap = await d.collection(DEVICES).doc(user.deviceId).get();
      const scopes = Array.isArray(vSnap.data()?.scopes) ? vSnap.data()!.scopes : [];
      if (!scopes.includes("remote:control")) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
    }
  }

  const sigRef = ref.collection("signals").doc();
  const createdMs = Date.now();
  await sigRef.set({
    from_role: input.from_role,
    kind: input.kind,
    payload: input.payload,
    created_at_ms: createdMs,
    created_at: nowTs(),
  });
  await ref.set({ last_signal_at: nowTs() }, { merge: true });
  return { signal_id: sigRef.id };
}

export async function listMirrorSignals(
  d: Db,
  user: SessionUser,
  input: { session_id: string; after_ms?: number },
): Promise<{
  session: MirrorSessionView;
  signals: Array<{ id: string; from_role: string; kind: string; payload: Record<string, unknown>; created_at_ms: number }>;
}> {
  const ref = d.collection(SESSIONS).doc(input.session_id);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  if (data.owner_uid !== user.uid) throw new RpcError("PERMISSION_DENIED", 403);

  const signalsSnap = await ref.collection("signals").get();
  const after = Number(input.after_ms ?? 0);
  const signals = signalsSnap.docs
    .map((doc) => {
      const sigData = (doc.data() ?? {}) as Record<string, unknown>;
      return {
        id: doc.id,
        from_role: String(sigData.from_role ?? ""),
        kind: String(sigData.kind ?? ""),
        payload: (sigData.payload && typeof sigData.payload === "object" ? sigData.payload : {}) as Record<string, unknown>,
        created_at_ms: Number(sigData.created_at_ms ?? 0),
      };
    })
    .filter((s) => s.created_at_ms > after)
    .sort((a, b) => a.created_at_ms - b.created_at_ms)
    .slice(-60);

  return { session: toView(snap.id, data), signals };
}

export async function stopMirrorSession(
  d: Db,
  user: SessionUser,
  input: { session_id: string; reason?: string },
): Promise<MirrorSessionView> {
  const ref = d.collection(SESSIONS).doc(input.session_id);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  if (data.owner_uid !== user.uid) throw new RpcError("PERMISSION_DENIED", 403);

  await ref.set(
    {
      status: "ended",
      remote_control_enabled: false,
      ended_at: nowTs(),
      ended_reason: clean(input.reason, 80) || "stopped_by_user",
    },
    { merge: true },
  );
  await audit(d, user.uid, "mirror.session_stopped", input.session_id, { reason: input.reason ?? "stopped_by_user" });
  const updated = await ref.get();
  return toView(updated.id, updated.data()!);
}

export async function listMirrorSessions(d: Db, user: SessionUser): Promise<MirrorSessionView[]> {
  const snap = await d.collection(SESSIONS).where("owner_uid", "==", user.uid).get();
  const nowMs = Date.now();
  return snap.docs
    .map((doc) => toView(doc.id, (doc.data() ?? {}) as Record<string, unknown>, nowMs))
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, 25);
}
