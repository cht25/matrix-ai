// =============================================================================
// MATRIX AI — MATRIX Connect: secure QR device pairing (server-only).
//
// Workflow: the account owner creates a short-lived, HMAC-signed pairing
// challenge (rendered as a QR code). A second device scans it, authenticates,
// and POSTs the payload; the server verifies the signature, expiry and
// one-time use inside a transaction, then registers the device with scoped
// authorization. Permanent tokens are NEVER placed in the QR payload.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";
import { env } from "@/lib/env";
import { deviceCredentialHash, DEVICE_TOKEN_PREFIX, DEVICE_CREDENTIAL_TTL_MS } from "@/lib/firebase/device-session";

export { RpcError };

const CHALLENGES = "pairing_challenges";
const DEVICES = "devices";

/** Pairing challenges live for 5 minutes and are single-use. */
export const PAIRING_TTL_MS = 1000 * 60 * 5;
export const QR_PROTOCOL = "matrix-pairing:v1";

/** Default scoped authorization granted to a paired device. */
export const DEFAULT_DEVICE_SCOPES = ["chat:read", "chat:write", "devices:read", "devices:write", "notifications:read"] as const;

function pairingSecret(): Buffer {
  // Optional dedicated secret; otherwise derive from server-only Firebase
  // credentials so no new mandatory env var is required.
  const explicit = process.env.PAIRING_HMAC_SECRET;
  const base = explicit && explicit.trim() ? explicit.trim() : `${env.firebasePublic.projectId}:${process.env.FIREBASE_PRIVATE_KEY ?? process.env.FIREBASE_CLIENT_EMAIL ?? "matrix-pairing-fallback"}`;
  return crypto.createHash("sha256").update(base).digest();
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", pairingSecret()).update(payload).digest("hex");
}

export type PairingChallenge = {
  challenge_id: string;
  qr_payload: string;
  expires_at: string;
};

/** Create a one-time pairing challenge for the signed-in account owner. */
export async function createPairingChallenge(
  d: Db,
  user: SessionUser,
  input: { device_label?: string } = {},
): Promise<PairingChallenge> {
  const id = crypto.randomBytes(12).toString("base64url");
  const exp = Date.now() + PAIRING_TTL_MS;
  const signed = `${QR_PROTOCOL}.${id}.${user.uid}.${exp}`;
  const qrPayload = `${signed}.${sign(signed)}`;
  await d.collection(CHALLENGES).doc(id).set({
    owner_uid: user.uid,
    device_label: (input.device_label ?? "").slice(0, 80),
    status: "pending",
    expires_at: Timestamp.fromMillis(exp),
    consumed_at: null,
    device_id: null,
    created_at: nowTs(),
  });
  return { challenge_id: id, qr_payload: qrPayload, expires_at: new Date(exp).toISOString() };
}

export type PairedDevice = {
  id: string;
  device_name: string;
  device_type: string;
  platform: string;
  scopes: string[];
  paired_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

export type VerifiedQrPayload = { challengeId: string; ownerUid: string; expiresAt: number };

/**
 * Pure verification of a QR payload: format, HMAC signature (timing-safe),
 * and expiry. Contains no credentials — only a challenge id + signature.
 */
export function verifyQrPayload(qrPayload: string, nowMs: number = Date.now()): VerifiedQrPayload {
  const parts = qrPayload.split(".");
  if (parts.length !== 5 || parts[0] !== "matrix-pairing:v1") throw new RpcError("PAIRING_INVALID", 400);
  const [, id, ownerUid, expRaw, sig] = parts;
  const exp = Number(expRaw);
  if (!id || !ownerUid || !Number.isFinite(exp) || !sig) throw new RpcError("PAIRING_INVALID", 400);
  const signed = `${QR_PROTOCOL}.${id}.${ownerUid}.${exp}`;
  const expected = sign(signed);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new RpcError("PAIRING_INVALID", 400);
  if (nowMs > exp) throw new RpcError("PAIRING_EXPIRED", 410);
  return { challengeId: id, ownerUid, expiresAt: exp };
}

/**
 * Complete pairing from a scanned QR payload. The scanning device must be
 * authenticated; the device is registered under the CHALLENGE OWNER's account
 * (that is the whole point of pairing: link a device to your own account).
 */
export async function completePairing(
  d: Db,
  scanner: SessionUser,
  input: { qr_payload: string; device_name: string; device_type: string; platform: string },
): Promise<PairedDevice & { access_token: string; access_token_expires_at: string }> {
  const verified = verifyQrPayload(input.qr_payload);
  // Device clients query the same authenticated owner registry. Cross-account
  // pairing used to succeed but made the scanning client show an empty list.
  if (scanner.uid !== verified.ownerUid) throw new RpcError("PAIRING_ACCOUNT_MISMATCH", 403);
  const id = verified.challengeId;

  const challengeRef = d.collection(CHALLENGES).doc(id);
  let deviceId = "";
  const secret = crypto.randomBytes(32).toString("base64url");
  const credentialExpires = Date.now() + DEVICE_CREDENTIAL_TTL_MS;
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(challengeRef);
    if (!snap.exists) throw new RpcError("PAIRING_INVALID", 404);
    const data = snap.data()!;
    if (data.owner_uid !== verified.ownerUid) throw new RpcError("PAIRING_INVALID", 400);
    // Approval-flow QR codes can only be used through the Parent-approved path
    // (device-hub.ts); they never grant a credential directly.
    if (data.flow === "approval") throw new RpcError("PAIRING_APPROVAL_REQUIRED", 403);
    if (data.status !== "pending" || data.consumed_at) throw new RpcError("PAIRING_USED", 409); // replay protection
    const expiresAt = (data.expires_at as Timestamp | undefined)?.toMillis?.() ?? 0;
    if (Date.now() > expiresAt) throw new RpcError("PAIRING_EXPIRED", 410);
    const deviceRef = d.collection(DEVICES).doc();
    deviceId = deviceRef.id;
    tx.set(deviceRef, {
      user_id: verified.ownerUid, // device belongs to the account owner, not the scanner
      device_name: input.device_name.slice(0, 80) || "MATRIX device",
      device_type: input.device_type.slice(0, 40),
      platform: input.platform.slice(0, 40),
      scopes: [...DEFAULT_DEVICE_SCOPES],
      access_token_hash: deviceCredentialHash(deviceId, secret),
      access_token_expires_at: Timestamp.fromMillis(credentialExpires),
      pairing_id: id,
      paired_by: scanner.uid,
      paired_at: nowTs(),
      last_seen_at: nowTs(),
      revoked_at: null,
      created_at: nowTs(),
    });
    tx.set(challengeRef, { status: "consumed", consumed_at: nowTs(), device_id: deviceId }, { merge: true });
  });

  await d.collection("audit_logs").add({
    actor_id: scanner.uid,
    action: "device.pair",
    target_type: "device",
    target_id: deviceId,
    reason: "QR pairing completed",
    metadata: { owner_uid: verified.ownerUid, platform: input.platform },
    created_at: nowTs(),
  });
  await d.collection("security_events").add({
    user_id: verified.ownerUid,
    event_type: "device_paired",
    detail: `Device "${input.device_name}" (${input.platform}) paired via QR by ${scanner.uid}`,
    created_at: nowTs(),
  });

  const snap = await d.collection(DEVICES).doc(deviceId).get();
  const data = snap.data()!;
  return {
    id: deviceId,
    device_name: data.device_name,
    device_type: data.device_type,
    platform: data.platform,
    scopes: data.scopes,
    paired_at: data.paired_at?.toDate?.().toISOString() ?? "",
    last_seen_at: data.last_seen_at?.toDate?.().toISOString() ?? "",
    revoked_at: null,
    access_token: `${DEVICE_TOKEN_PREFIX}${deviceId}.${secret}`,
    access_token_expires_at: new Date(credentialExpires).toISOString(),
  };
}

export async function listDevices(d: Db, uid: string): Promise<PairedDevice[]> {
  const snap = await d.collection(DEVICES).where("user_id", "==", uid).get();
  return snap.docs
    // An approved registration its device has not collected yet is not a device.
    .filter((doc) => doc.data().role !== "child" || typeof doc.data().access_token_hash === "string")
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        device_name: String(data.device_name ?? ""),
        device_type: String(data.device_type ?? ""),
        platform: String(data.platform ?? ""),
        scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
        paired_at: data.paired_at?.toDate?.().toISOString() ?? "",
        last_seen_at: data.last_seen_at?.toDate?.().toISOString() ?? "",
        revoked_at: data.revoked_at ? data.revoked_at.toDate().toISOString() : null,
      } as PairedDevice;
    })
    .filter((device) => !device.revoked_at)
    .sort((a, b) => b.paired_at.localeCompare(a.paired_at));
}

export async function revokeDevice(d: Db, user: SessionUser, deviceId: string): Promise<boolean> {
  const ref = d.collection(DEVICES).doc(deviceId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  await ref.set({ revoked_at: nowTs() }, { merge: true });
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: "device.revoke",
    target_type: "device",
    target_id: deviceId,
    reason: "User revoked device access",
    metadata: {},
    created_at: nowTs(),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Own-device telemetry (app usage, hidden apps, browser history, screen time)
// Reported by the Tauri desktop app or Flutter mobile companion app.
// ---------------------------------------------------------------------------

export type OwnDeviceActivitySnapshot = {
  id: string;
  device_id: string;
  device_name: string;
  platform: string;
  reported_at: string;
  screen_time_minutes: number;
  apps: Array<{ name: string; package: string; minutes: number; hidden: boolean; last_used: string }>;
  hidden_apps: Array<{ name: string; package: string; minutes: number; hidden: boolean; last_used: string }>;
  browser_history: Array<{ url: string; title: string; visited_at: string }>;
};

function sanitizeOwnApps(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 120) : "";
    if (!name) return [];
    return [{
      name,
      package: typeof row.package === "string" ? row.package.slice(0, 160) : "",
      minutes: Math.max(0, Math.min(1440, Math.round(Number(row.minutes ?? 0)))),
      hidden: row.hidden === true,
      last_used: typeof row.last_used === "string" ? row.last_used.slice(0, 40) : "",
    }];
  });
}

function sanitizeOwnHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 300).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim().slice(0, 500) : "";
    if (!url) return [];
    return [{
      url,
      title: typeof row.title === "string" ? row.title.slice(0, 200) : "",
      visited_at: typeof row.visited_at === "string" ? row.visited_at.slice(0, 40) : "",
    }];
  });
}

export async function reportOwnDeviceActivity(
  d: Db,
  user: SessionUser,
  input: {
    device_id?: string;
    device_name?: string;
    platform?: string;
    screen_time_minutes?: number;
    apps?: unknown;
    hidden_apps?: unknown;
    browser_history?: unknown;
  },
): Promise<{ ok: true; reported_at: string }> {
  const deviceId = (input.device_id || user.deviceId || "primary").slice(0, 120);
  let deviceName = (input.device_name ?? "").trim().slice(0, 80);
  let platform = (input.platform ?? "").trim().slice(0, 40) || "desktop";
  if (deviceId && deviceId !== "primary") {
    const devSnap = await d.collection(DEVICES).doc(deviceId).get().catch(() => null);
    if (devSnap?.exists && devSnap.data()?.user_id === user.uid) {
      deviceName = deviceName || String(devSnap.data()?.device_name ?? "Device");
      platform = String(devSnap.data()?.platform ?? platform);
      await devSnap.ref.set({ last_seen_at: nowTs() }, { merge: true }).catch(() => {});
    }
  }
  const apps = sanitizeOwnApps(input.apps);
  const explicitHidden = sanitizeOwnApps(input.hidden_apps);
  const hiddenFromApps = apps.filter((a) => a.hidden);
  const seenHidden = new Set(explicitHidden.map((a) => `${a.name}:${a.package}`));
  const hiddenApps = [
    ...explicitHidden,
    ...hiddenFromApps.filter((a) => !seenHidden.has(`${a.name}:${a.package}`)),
  ];
  const browserHistory = sanitizeOwnHistory(input.browser_history);
  const screenMinutes = Math.max(
    0,
    Math.min(1440, Math.round(input.screen_time_minutes ?? apps.reduce((sum, a) => sum + a.minutes, 0))),
  );
  const now = nowTs();
  await d.collection("device_activity").doc(`${user.uid}_${deviceId}`).set({
    user_id: user.uid,
    device_id: deviceId,
    device_name: deviceName || "This device",
    platform,
    screen_time_minutes: screenMinutes,
    apps,
    hidden_apps: hiddenApps,
    browser_history: browserHistory,
    reported_at: now,
    updated_at: now,
  });

  // Also mirror into family_activity when the user has a family-linked device
  // so family supervision sees fresh telemetry from a single companion sync.
  const famDevices = await d.collection("family_devices").where("user_id", "==", user.uid).get().catch(() => null);
  const activeFamDevice = famDevices?.docs.find((doc) => !doc.data().revoked_at);
  if (activeFamDevice) {
    await d.collection("family_activity").add({
      user_id: user.uid,
      family_id: String(activeFamDevice.data().family_id ?? ""),
      member_id: String(activeFamDevice.data().member_id ?? ""),
      device_id: activeFamDevice.id,
      screen_time_minutes: screenMinutes,
      apps,
      hidden_apps: hiddenApps,
      browser_history: browserHistory,
      reported_at: now,
      created_at: now,
    }).catch(() => {});
    await activeFamDevice.ref.set({ last_seen_at: now }, { merge: true }).catch(() => {});
  }

  return { ok: true, reported_at: now.toDate().toISOString() };
}

export async function getOwnDeviceActivity(d: Db, user: SessionUser): Promise<OwnDeviceActivitySnapshot[]> {
  const snap = await d.collection("device_activity").where("user_id", "==", user.uid).get();
  return snap.docs
    .map((doc) => {
      const data = doc.data();
      const reportedAt = (data.reported_at as { toDate?: () => Date } | undefined)?.toDate?.().toISOString() ?? "";
      return {
        id: doc.id,
        device_id: String(data.device_id ?? ""),
        device_name: String(data.device_name ?? "This device"),
        platform: String(data.platform ?? "desktop"),
        reported_at: reportedAt,
        screen_time_minutes: Number(data.screen_time_minutes ?? 0),
        apps: Array.isArray(data.apps) ? data.apps.slice(0, 80) : [],
        hidden_apps: Array.isArray(data.hidden_apps) ? data.hidden_apps.slice(0, 60) : [],
        browser_history: Array.isArray(data.browser_history) ? data.browser_history.slice(0, 100) : [],
      };
    })
    .sort((a, b) => b.reported_at.localeCompare(a.reported_at));
}
