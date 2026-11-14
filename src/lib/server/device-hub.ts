// =============================================================================
// MATRIX AI — Device hub: Parent / Child registration with approved QR pairing.
//
// Roles
//   parent  A signed-in browser or app that manages the account's devices. It
//           generates pairing QR codes, approves requests, and manages names,
//           permissions and access.
//   child   A device that joined by scanning a Parent's QR code (or typing its
//           pairing code) and was then approved by the Parent.
//
// Pairing protocol (extends the signed challenge in pairing.ts)
//   1. Parent  → createParentPairing: 5-minute HMAC-signed, single-use
//                challenge. The QR holds only the challenge id + signature.
//   2. Child   → requestPairing: verifies the QR (or the short manual code),
//                records the device's details and a hash of a claim secret
//                that only this device knows. No credential is issued.
//   3. Parent  → decidePairing: approves (creating the device record with the
//                chosen permissions) or denies.
//   4. Child   → claimPairing: presents the claim secret; exactly once, the
//                server issues the device credential.
//
// A scanned QR can therefore never grant access by itself: the Parent must
// approve, and only the device that made the request can collect the result.
// Every step is transactional, expiring, and audited.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";
import { deviceCredentialHash, DEVICE_TOKEN_PREFIX, DEVICE_CREDENTIAL_TTL_MS } from "@/lib/firebase/device-session";
import { createPairingChallenge, verifyQrPayload, PAIRING_TTL_MS } from "@/lib/server/pairing";
import {
  DEVICE_PERMISSIONS,
  DEFAULT_CHILD_PERMISSIONS,
  connectionStatus,
  normalizeManualCode,
  sanitizePermissions,
  type DevicePermission,
  type DeviceRole,
  type HubDevice,
  type PairingRequestView,
} from "@/lib/devices/model";

const CHALLENGES = "pairing_challenges";
const DEVICES = "devices";
const ATTEMPTS = "pairing_attempts";

/** After a Child has requested pairing the Parent has this long to decide. */
export const APPROVAL_WINDOW_MS = 1000 * 60 * 10;
/** After approval the Child has this long to collect its credential. */
export const CLAIM_WINDOW_MS = 1000 * 60 * 10;
const MANUAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const MAX_ATTEMPTS = 12;
const ATTEMPT_WINDOW_MS = 1000 * 60 * 5;

const millis = (value: unknown): number =>
  Number((value as { toMillis?: () => number } | null)?.toMillis?.() ?? (value instanceof Date ? value.getTime() : typeof value === "number" ? value : 0));
const iso = (value: unknown): string => {
  const ms = millis(value);
  return ms ? new Date(ms).toISOString() : "";
};
const text = (value: unknown, max: number): string => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const sha256 = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

function accountOnly(user: SessionUser): void {
  // Managing devices is an account action. A paired device's scoped credential
  // can never register, approve, rename, or re-authorise devices.
  if (user.deviceId) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
}

async function audit(d: Db, actor: string, action: string, deviceId: string, reason: string, metadata: Record<string, unknown> = {}): Promise<void> {
  try {
    await d.collection("audit_logs").add({ actor_id: actor, action, target_type: "device", target_id: deviceId, reason, metadata, created_at: nowTs() });
  } catch (error) {
    console.error("[MATRIX] device audit log write failed", action, error instanceof Error ? error.message : "unknown");
  }
}

/** Sliding-window limiter for pairing attempts (per account). */
async function limitAttempts(d: Db, uid: string, nowMs: number): Promise<void> {
  const ref = d.collection(ATTEMPTS).doc(uid);
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data()! : {};
    const windowStart = Number(data.window_start ?? 0);
    const fresh = nowMs - windowStart > ATTEMPT_WINDOW_MS;
    const count = fresh ? 0 : Number(data.count ?? 0);
    if (count >= MAX_ATTEMPTS) throw new RpcError("PAIRING_RATE_LIMITED", 429);
    tx.set(ref, { window_start: fresh ? nowMs : windowStart, count: count + 1 });
  });
}

function toDevice(id: string, data: Record<string, unknown>, nowMs: number, currentDeviceId: string | null): HubDevice {
  const role: DeviceRole = data.role === "parent" ? "parent" : "child";
  const lastSeen = millis(data.last_seen_at);
  return {
    id,
    device_name: text(data.device_name, 80) || "MATRIX device",
    device_type: text(data.device_type, 40) || "device",
    platform: text(data.platform, 40) || "unknown",
    os: text(data.os, 60),
    app_version: text(data.app_version, 40),
    role,
    parent_device_id: typeof data.parent_device_id === "string" ? data.parent_device_id : null,
    permissions: sanitizePermissions(data.scopes),
    status: connectionStatus({ revoked: Boolean(data.revoked_at), suspended: Boolean(data.suspended_at), credentialed: role === "parent" || typeof data.access_token_hash === "string", lastSeenMs: lastSeen, nowMs }),
    registered_at: iso(data.paired_at ?? data.created_at),
    last_active_at: iso(data.last_seen_at),
    is_current: id === currentDeviceId,
  };
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

/** Deterministic id for "this browser/app install" so re-registering is idempotent. */
export function parentDeviceId(uid: string, clientId: string): string {
  return `p_${sha256(`${uid}:${clientId}`).slice(0, 26)}`;
}

/**
 * Register (or refresh) the signed-in browser/app as a Parent device. It is
 * authenticated by the account session itself, so no device credential is
 * issued for it.
 */
export async function registerParentDevice(
  d: Db,
  user: SessionUser,
  input: { client_id: string; device_name: string; device_type: string; platform: string; os?: string; app_version?: string },
): Promise<HubDevice> {
  accountOnly(user);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.client_id)) throw new RpcError("BAD_REQUEST", 400);
  const id = parentDeviceId(user.uid, input.client_id);
  const ref = d.collection(DEVICES).doc(id);
  let created = false;
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data()!;
      if (data.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
      if (data.revoked_at) throw new RpcError("DEVICE_REVOKED", 403);
      tx.set(ref, { last_seen_at: nowTs(), os: text(input.os, 60), app_version: text(input.app_version, 40) }, { merge: true });
      return;
    }
    created = true;
    tx.set(ref, {
      user_id: user.uid,
      role: "parent",
      device_name: text(input.device_name, 80) || "MATRIX device",
      device_type: text(input.device_type, 40) || "desktop",
      platform: text(input.platform, 40) || "web",
      os: text(input.os, 60),
      app_version: text(input.app_version, 40),
      scopes: [...DEVICE_PERMISSIONS],
      access_token_hash: null,
      parent_device_id: null,
      paired_at: nowTs(),
      last_seen_at: nowTs(),
      revoked_at: null,
      suspended_at: null,
      created_at: nowTs(),
    });
  });
  if (created) await audit(d, user.uid, "device.register_parent", id, "Registered as Parent device", { platform: text(input.platform, 40) });
  const snap = await ref.get();
  return toDevice(id, snap.data()!, Date.now(), id);
}

function manualCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (const byte of bytes) code += MANUAL_CODE_ALPHABET[byte % MANUAL_CODE_ALPHABET.length];
  return code;
}

async function ownParent(d: Db, uid: string, deviceId: string): Promise<void> {
  const snap = await d.collection(DEVICES).doc(deviceId).get();
  const data = snap.exists ? snap.data()! : null;
  if (!data || data.user_id !== uid || data.role !== "parent" || data.revoked_at) throw new RpcError("PARENT_DEVICE_REQUIRED", 403);
}

/** Parent: create a temporary signed pairing challenge (QR + manual code). */
export async function createParentPairing(
  d: Db,
  user: SessionUser,
  input: { parent_device_id: string; device_label?: string },
): Promise<{ challenge_id: string; qr_payload: string; manual_code: string; expires_at: string }> {
  accountOnly(user);
  await ownParent(d, user.uid, input.parent_device_id);
  const challenge = await createPairingChallenge(d, user, { device_label: input.device_label });
  const code = manualCode();
  await d.collection(CHALLENGES).doc(challenge.challenge_id).set(
    { flow: "approval", parent_device_id: input.parent_device_id, manual_code_hash: sha256(`${user.uid}:${code}`) },
    { merge: true },
  );
  return { ...challenge, manual_code: code };
}

/** Parent: pairing requests waiting for a decision. */
export async function listPairingRequests(d: Db, user: SessionUser, nowMs: number = Date.now()): Promise<PairingRequestView[]> {
  accountOnly(user);
  const snap = await d.collection(CHALLENGES).where("owner_uid", "==", user.uid).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as Record<string, unknown> }))
    .filter(({ data }) => data.flow === "approval" && data.status === "requested" && millis(data.decide_by) > nowMs)
    .map(({ id, data }) => {
      const request = (data.request ?? {}) as Record<string, unknown>;
      return {
        challenge_id: id,
        device_name: text(request.device_name, 80) || "MATRIX device",
        device_type: text(request.device_type, 40),
        platform: text(request.platform, 40),
        os: text(request.os, 60),
        app_version: text(request.app_version, 40),
        requested_at: iso(data.requested_at),
        decide_by: iso(data.decide_by),
      };
    })
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
}

/** Parent: approve or deny a pairing request. */
export async function decidePairing(
  d: Db,
  user: SessionUser,
  input: { challenge_id: string; approve: boolean; permissions?: unknown; device_name?: string },
  nowMs: number = Date.now(),
): Promise<{ status: "approved" | "denied"; device: HubDevice | null }> {
  accountOnly(user);
  const ref = d.collection(CHALLENGES).doc(input.challenge_id);
  const permissions = input.permissions === undefined ? [...DEFAULT_CHILD_PERMISSIONS] : sanitizePermissions(input.permissions);
  let deviceId = "";
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data()! : null;
    if (!data || data.owner_uid !== user.uid || data.flow !== "approval") throw new RpcError("NOT_FOUND", 404);
    if (data.status !== "requested") throw new RpcError("PAIRING_NOT_PENDING", 409);
    if (millis(data.decide_by) <= nowMs) {
      tx.set(ref, { status: "expired" }, { merge: true });
      throw new RpcError("PAIRING_EXPIRED", 410);
    }
    if (!input.approve) {
      tx.set(ref, { status: "denied", decided_at: nowTs(), decided_by: user.uid }, { merge: true });
      return;
    }
    const request = (data.request ?? {}) as Record<string, unknown>;
    const deviceRef = d.collection(DEVICES).doc();
    deviceId = deviceRef.id;
    tx.set(deviceRef, {
      user_id: user.uid,
      role: "child",
      parent_device_id: typeof data.parent_device_id === "string" ? data.parent_device_id : null,
      device_name: text(input.device_name, 80) || text(request.device_name, 80) || "MATRIX device",
      device_type: text(request.device_type, 40) || "device",
      platform: text(request.platform, 40) || "unknown",
      os: text(request.os, 60),
      app_version: text(request.app_version, 40),
      scopes: permissions,
      // No credential exists until the requesting device claims it.
      access_token_hash: null,
      access_token_expires_at: null,
      pairing_id: input.challenge_id,
      paired_by: text(data.requested_by, 128) || user.uid,
      approved_by: user.uid,
      paired_at: nowTs(),
      last_seen_at: null,
      revoked_at: null,
      suspended_at: null,
      created_at: nowTs(),
    });
    tx.set(ref, { status: "approved", decided_at: nowTs(), decided_by: user.uid, device_id: deviceId, claim_by: Timestamp.fromMillis(nowMs + CLAIM_WINDOW_MS) }, { merge: true });
  });
  if (!input.approve) {
    await audit(d, user.uid, "device.pairing_denied", input.challenge_id, "Parent denied a pairing request");
    return { status: "denied", device: null };
  }
  await audit(d, user.uid, "device.pairing_approved", deviceId, "Parent approved a pairing request", { permissions });
  const snap = await d.collection(DEVICES).doc(deviceId).get();
  return { status: "approved", device: toDevice(deviceId, snap.data()!, nowMs, null) };
}

// ---------------------------------------------------------------------------
// Child
// ---------------------------------------------------------------------------

async function challengeFromManualCode(d: Db, uid: string, code: string): Promise<string> {
  const hash = sha256(`${uid}:${normalizeManualCode(code)}`);
  const snap = await d.collection(CHALLENGES).where("owner_uid", "==", uid).get();
  const match = snap.docs.find((doc) => doc.data().manual_code_hash === hash && doc.data().flow === "approval");
  if (!match) throw new RpcError("PAIRING_INVALID", 404);
  return match.id;
}

/**
 * Child: ask to be registered. Accepts the scanned QR payload or the manual
 * pairing code. Issues NO credential — only a claim secret for step 4.
 */
export async function requestPairing(
  d: Db,
  scanner: SessionUser,
  input: { qr_payload?: string; manual_code?: string; device_name: string; device_type: string; platform: string; os?: string; app_version?: string },
  nowMs: number = Date.now(),
): Promise<{ challenge_id: string; claim_secret: string; status: "requested"; decide_by: string }> {
  accountOnly(scanner);
  await limitAttempts(d, scanner.uid, nowMs);
  let challengeId: string;
  if (input.qr_payload) {
    const verified = verifyQrPayload(input.qr_payload, nowMs);
    // Devices join the account they are signed in to; linking a different
    // person's device is the separate, consent-based Family feature.
    if (verified.ownerUid !== scanner.uid) throw new RpcError("PAIRING_ACCOUNT_MISMATCH", 403);
    challengeId = verified.challengeId;
  } else if (input.manual_code) {
    challengeId = await challengeFromManualCode(d, scanner.uid, input.manual_code);
  } else {
    throw new RpcError("BAD_REQUEST", 400);
  }

  const claimSecret = crypto.randomBytes(32).toString("base64url");
  const decideBy = nowMs + APPROVAL_WINDOW_MS;
  const ref = d.collection(CHALLENGES).doc(challengeId);
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data()! : null;
    if (!data || data.owner_uid !== scanner.uid) throw new RpcError("PAIRING_INVALID", 404);
    if (data.flow !== "approval") throw new RpcError("PAIRING_INVALID", 400);
    if (data.status !== "pending" || data.consumed_at) throw new RpcError("PAIRING_USED", 409); // one request per QR
    if (millis(data.expires_at) <= nowMs) throw new RpcError("PAIRING_EXPIRED", 410);
    tx.set(ref, {
      status: "requested",
      requested_at: nowTs(),
      requested_by: scanner.uid,
      decide_by: Timestamp.fromMillis(decideBy),
      claim_hash: sha256(`${challengeId}.${claimSecret}`),
      request: {
        device_name: text(input.device_name, 80) || "MATRIX device",
        device_type: text(input.device_type, 40) || "device",
        platform: text(input.platform, 40) || "unknown",
        os: text(input.os, 60),
        app_version: text(input.app_version, 40),
      },
    }, { merge: true });
  });
  await audit(d, scanner.uid, "device.pairing_requested", challengeId, "Child device requested registration", { platform: text(input.platform, 40) });
  return { challenge_id: challengeId, claim_secret: claimSecret, status: "requested", decide_by: new Date(decideBy).toISOString() };
}

export type ClaimResult =
  | { status: "requested" | "denied" | "expired" }
  | { status: "approved"; device: HubDevice; parent: { id: string; device_name: string } | null; access_token: string; access_token_expires_at: string };

/**
 * Child: poll for the Parent's decision. On approval the device credential is
 * issued exactly once, to the holder of the claim secret.
 */
export async function claimPairing(
  d: Db,
  scanner: SessionUser,
  input: { challenge_id: string; claim_secret: string },
  nowMs: number = Date.now(),
): Promise<ClaimResult> {
  accountOnly(scanner);
  const ref = d.collection(CHALLENGES).doc(input.challenge_id);
  const secret = crypto.randomBytes(32).toString("base64url");
  const expires = nowMs + DEVICE_CREDENTIAL_TTL_MS;
  type Outcome = "requested" | "denied" | "expired" | "approved";
  let deviceId = "";
  const outcome: Outcome = await d.runTransaction(async (tx): Promise<Outcome> => {
    let outcome: Outcome = "requested";
    const result = await (async () => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data()! : null;
    if (!data || data.owner_uid !== scanner.uid || data.flow !== "approval" || typeof data.claim_hash !== "string") throw new RpcError("PAIRING_INVALID", 404);
    const presented = Buffer.from(sha256(`${input.challenge_id}.${input.claim_secret}`));
    const expected = Buffer.from(data.claim_hash);
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) throw new RpcError("PAIRING_INVALID", 403);
    if (data.status === "consumed") throw new RpcError("PAIRING_USED", 409); // replay protection
    if (data.status === "denied") { outcome = "denied"; return; }
    if (data.status === "expired") { outcome = "expired"; return; }
    if (data.status === "requested") {
      if (millis(data.decide_by) <= nowMs) { tx.set(ref, { status: "expired" }, { merge: true }); outcome = "expired"; }
      return;
    }
    if (data.status !== "approved" || typeof data.device_id !== "string") throw new RpcError("PAIRING_INVALID", 400);
    const deviceRef = d.collection(DEVICES).doc(data.device_id);
    const deviceSnap = await tx.get(deviceRef);
    const device = deviceSnap.exists ? deviceSnap.data()! : null;
    if (!device || device.user_id !== scanner.uid || device.revoked_at) { tx.set(ref, { status: "expired" }, { merge: true }); outcome = "expired"; return; }
    if (millis(data.claim_by) <= nowMs) {
      // Approved but never collected: withdraw the unused registration.
      tx.set(deviceRef, { revoked_at: nowTs() }, { merge: true });
      tx.set(ref, { status: "expired" }, { merge: true });
      outcome = "expired";
      return;
    }
    deviceId = data.device_id;
    tx.set(deviceRef, { access_token_hash: deviceCredentialHash(deviceId, secret), access_token_expires_at: Timestamp.fromMillis(expires), last_seen_at: nowTs() }, { merge: true });
    tx.set(ref, { status: "consumed", consumed_at: nowTs() }, { merge: true });
    outcome = "approved";
    })();
    void result;
    return outcome;
  });
  if (outcome !== "approved") return { status: outcome };

  await audit(d, scanner.uid, "device.pair", deviceId, "Approved pairing completed");
  try {
    await d.collection("security_events").add({ user_id: scanner.uid, event_type: "device_paired", detail: "A Child device completed approved QR pairing", created_at: nowTs() });
  } catch { /* the audit log above is the durable record */ }
  const snap = await d.collection(DEVICES).doc(deviceId).get();
  const data = snap.data()!;
  let parent: { id: string; device_name: string } | null = null;
  if (typeof data.parent_device_id === "string") {
    const parentSnap = await d.collection(DEVICES).doc(data.parent_device_id).get();
    if (parentSnap.exists && parentSnap.data()!.user_id === scanner.uid) parent = { id: data.parent_device_id, device_name: text(parentSnap.data()!.device_name, 80) };
  }
  return {
    status: "approved",
    device: toDevice(deviceId, data, nowMs, deviceId),
    parent,
    access_token: `${DEVICE_TOKEN_PREFIX}${deviceId}.${secret}`,
    access_token_expires_at: new Date(expires).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dashboard + management
// ---------------------------------------------------------------------------

/** Every non-revoked device on the account, with real status. */
export async function listHubDevices(d: Db, user: SessionUser, opts: { current_device_id?: string | null } = {}, nowMs: number = Date.now()): Promise<HubDevice[]> {
  const current = user.deviceId ?? opts.current_device_id ?? null;
  const snap = await d.collection(DEVICES).where("user_id", "==", user.uid).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as Record<string, unknown> }))
    .filter(({ data }) => !data.revoked_at)
    // An approved registration that the Child has not collected yet is not a device.
    .filter(({ data }) => data.role === "parent" || typeof data.access_token_hash === "string")
    .map(({ id, data }) => toDevice(id, data, nowMs, current))
    .sort((a, b) => (a.role === b.role ? b.registered_at.localeCompare(a.registered_at) : a.role === "parent" ? -1 : 1));
}

async function ownedDevice(d: Db, uid: string, deviceId: string) {
  const ref = d.collection(DEVICES).doc(deviceId);
  const snap = await ref.get();
  const data = snap.exists ? snap.data()! : null;
  if (!data || data.user_id !== uid || data.revoked_at) throw new RpcError("NOT_FOUND", 404);
  return { ref, data };
}

/** Rename a device and/or change a Child device's permissions. */
export async function updateDevice(
  d: Db,
  user: SessionUser,
  input: { device_id: string; device_name?: string; permissions?: unknown },
): Promise<HubDevice> {
  accountOnly(user);
  const { ref, data } = await ownedDevice(d, user.uid, input.device_id);
  const patch: Record<string, unknown> = {};
  if (input.device_name !== undefined) {
    const name = text(input.device_name, 80);
    if (!name) throw new RpcError("BAD_REQUEST", 400);
    patch.device_name = name;
  }
  let permissions: DevicePermission[] | null = null;
  if (input.permissions !== undefined) {
    if (data.role === "parent") throw new RpcError("PARENT_PERMISSIONS_FIXED", 400);
    permissions = sanitizePermissions(input.permissions);
    patch.scopes = permissions;
  }
  if (!Object.keys(patch).length) throw new RpcError("BAD_REQUEST", 400);
  await ref.set(patch, { merge: true });
  await audit(d, user.uid, permissions ? "device.permissions" : "device.rename", input.device_id, permissions ? "Device permissions changed" : "Device renamed", permissions ? { permissions } : {});
  const snap = await ref.get();
  return toDevice(input.device_id, snap.data()!, Date.now(), null);
}

/**
 * Disconnect (suspend) or reconnect a Child device. A disconnected device
 * keeps its registration but its credential is refused until reconnected.
 */
export async function setDeviceConnection(d: Db, user: SessionUser, input: { device_id: string; connected: boolean }): Promise<HubDevice> {
  accountOnly(user);
  const { ref, data } = await ownedDevice(d, user.uid, input.device_id);
  if (data.role === "parent") throw new RpcError("PARENT_CONNECTION_FIXED", 400);
  await ref.set({ suspended_at: input.connected ? null : nowTs() }, { merge: true });
  await audit(d, user.uid, input.connected ? "device.reconnect" : "device.disconnect", input.device_id, input.connected ? "Device reconnected" : "Device disconnected");
  const snap = await ref.get();
  return toDevice(input.device_id, snap.data()!, Date.now(), null);
}

/** Permanently revoke a device. Its credential stops working immediately. */
export async function revokeHubDevice(d: Db, user: SessionUser, deviceId: string): Promise<true> {
  accountOnly(user);
  const { ref } = await ownedDevice(d, user.uid, deviceId);
  await ref.set({ revoked_at: nowTs(), access_token_hash: null }, { merge: true });
  await audit(d, user.uid, "device.revoke", deviceId, "User revoked device access");
  return true;
}

/** A paired device asking about itself (also serves as its heartbeat). */
export async function deviceSelf(d: Db, user: SessionUser): Promise<{ device: HubDevice; parent: { id: string; device_name: string } | null }> {
  if (!user.deviceId) throw new RpcError("DEVICE_CREDENTIAL_REQUIRED", 400);
  const snap = await d.collection(DEVICES).doc(user.deviceId).get();
  const data = snap.exists ? snap.data()! : null;
  if (!data || data.user_id !== user.uid || data.revoked_at) throw new RpcError("NOT_FOUND", 404);
  let parent: { id: string; device_name: string } | null = null;
  if (typeof data.parent_device_id === "string") {
    const parentSnap = await d.collection(DEVICES).doc(data.parent_device_id).get();
    if (parentSnap.exists && parentSnap.data()!.user_id === user.uid && !parentSnap.data()!.revoked_at) parent = { id: data.parent_device_id, device_name: text(parentSnap.data()!.device_name, 80) };
  }
  return { device: toDevice(user.deviceId, data, Date.now(), user.deviceId), parent };
}

export { PAIRING_TTL_MS };
