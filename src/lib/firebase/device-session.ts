import "server-only";
import crypto from "node:crypto";
import { headers } from "next/headers";
import { adminDb, type Db } from "@/lib/firebase/admin";
import { getSessionUser, type SessionUser } from "@/lib/firebase/session";

export const DEVICE_TOKEN_PREFIX = "matrix_device.";
export const DEVICE_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Build/deploy APIs accept Firebase ID tokens, never Matrix scoped device tokens. */
export function isFirebaseIdTokenCandidate(token: string): boolean {
  return !token.startsWith(DEVICE_TOKEN_PREFIX) && token.split(".").length === 3 && token.trim() === token;
}

export function deviceCredentialHash(deviceId: string, secret: string): string {
  return crypto.createHash("sha256").update(`${deviceId}.${secret}`).digest("hex");
}
export function parseDeviceToken(token: string): { deviceId: string; secret: string } | null {
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[a-zA-Z0-9_-]{10,128}$/.test(parts[1]) || !/^[a-zA-Z0-9_-]{43}$/.test(parts[2])) return null;
  return { deviceId: parts[1], secret: parts[2] };
}
const millis = (value: unknown) => Number((value as { toMillis?: () => number })?.toMillis?.() ?? (typeof value === "number" ? value : 0));

/** Raw credentials are never stored. Revocation/expiry is checked every request. */
export async function verifyDeviceCredential(d: Db, token: string, nowMs = Date.now()): Promise<SessionUser | null> {
  const parsed = parseDeviceToken(token);
  if (!parsed) return null;
  const snap = await d.collection("devices").doc(parsed.deviceId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (data.revoked_at || millis(data.access_token_expires_at) <= nowMs || typeof data.access_token_hash !== "string") return null;
  const actual = Buffer.from(deviceCredentialHash(parsed.deviceId, parsed.secret));
  const expected = Buffer.from(data.access_token_hash);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  // Last_seen is telemetry, not authorization. Do not turn a telemetry outage
  // into a successful-looking device action or block an otherwise valid token.
  void snap.ref.set({ last_seen_at: new Date(nowMs) }, { merge: true }).catch(() => {});
  return { uid: String(data.user_id), email: null, emailVerified: false, deviceId: parsed.deviceId, scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [] };
}

/** Only explicitly device-aware APIs opt in; account/admin/file APIs do not. */
export async function getApiSessionUser(request?: Request): Promise<SessionUser | null> {
  const authorization = request ? request.headers.get("authorization") ?? "" : (await headers()).get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  if (token?.startsWith(DEVICE_TOKEN_PREFIX)) {
    try { return await verifyDeviceCredential(adminDb(), token); } catch { return null; }
  }
  return getSessionUser();
}
export function hasDeviceScope(user: SessionUser, scope: string): boolean {
  return !user.deviceId || Boolean(user.scopes?.includes(scope));
}
export function deviceScopeResponse(user: SessionUser, scope: string): Response | null {
  return hasDeviceScope(user, scope) ? null : Response.json({ error: "DEVICE_SCOPE_DENIED" }, { status: 403 });
}
export function rpcDeviceScope(action: string, method = "POST"): string | null {
  if (action.startsWith("conversation_")) return /^(conversation_list|conversation_get|conversation_history|conversation_messages)$/.test(action) ? "chat:read" : "chat:write";
  if (action.startsWith("notifications_")) return action === "notifications_list" ? "notifications:read" : "notifications:write";
  if (action === "onboarding_status") return "account:read";
  return null;
}
