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

export { RpcError };

const CHALLENGES = "pairing_challenges";
const DEVICES = "devices";

/** Pairing challenges live for 5 minutes and are single-use. */
export const PAIRING_TTL_MS = 1000 * 60 * 5;
export const QR_PROTOCOL = "matrix-pairing:v1";

/** Default scoped authorization granted to a paired device. */
export const DEFAULT_DEVICE_SCOPES = ["chat:read", "devices:read", "notifications:read"] as const;

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
): Promise<PairedDevice> {
  const verified = verifyQrPayload(input.qr_payload);
  // Device clients query the same authenticated owner registry. Cross-account
  // pairing used to succeed but made the scanning client show an empty list.
  if (scanner.uid !== verified.ownerUid) throw new RpcError("PAIRING_ACCOUNT_MISMATCH", 403);
  const id = verified.challengeId;

  const challengeRef = d.collection(CHALLENGES).doc(id);
  let deviceId = "";
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(challengeRef);
    if (!snap.exists) throw new RpcError("PAIRING_INVALID", 404);
    const data = snap.data()!;
    if (data.owner_uid !== verified.ownerUid) throw new RpcError("PAIRING_INVALID", 400);
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
  };
}

export async function listDevices(d: Db, uid: string): Promise<PairedDevice[]> {
  const snap = await d.collection(DEVICES).where("user_id", "==", uid).get();
  return snap.docs
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
