import "server-only";
import crypto from "node:crypto";
import { headers } from "next/headers";
import { adminDb, type Db } from "@/lib/firebase/admin";
import { getSessionUser, type SessionUser } from "@/lib/firebase/session";

export const DEVICE_TOKEN_PREFIX = "matrix_device.";
export const DEVICE_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Build/deploy APIs accept Firebase ID tokens, never QORVYNA scoped device tokens. */
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
const millis = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const ts = value as { toMillis?: () => number; _seconds?: number; seconds?: number } | null | undefined;
  if (typeof ts?.toMillis === "function") return Number(ts.toMillis());
  if (typeof ts?._seconds === "number") return ts._seconds * 1000;
  if (typeof ts?.seconds === "number") return ts.seconds * 1000;
  return 0;
};

/** Raw credentials are never stored. Revocation/expiry is checked every request. */
export async function verifyDeviceCredential(d: Db, token: string, nowMs = Date.now()): Promise<SessionUser | null> {
  const parsed = parseDeviceToken(token);
  if (!parsed) return null;
  let snap = await d.collection("devices").doc(parsed.deviceId).get();
  if (!snap.exists) {
    snap = await d.collection("family_devices").doc(parsed.deviceId).get();
  }
  if (!snap.exists) return null;
  const data = snap.data()!;
  // Revoked, disconnected (suspended) and expired credentials are all refused.
  if (data.revoked_at || data.suspended_at || millis(data.access_token_expires_at) <= nowMs || typeof data.access_token_hash !== "string") return null;
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
  void method;
  if (action.startsWith("conversation_")) return /^(conversation_list|conversation_get|conversation_history|conversation_messages)$/.test(action) ? "chat:read" : "chat:write";
  if (action === "notifications_sync_list" || action === "notifications_sync_prefs_get" || action === "notifications_sync_mark_read") return "notifications:read";
  if (action === "notifications_sync_ingest" || action === "notifications_sync_dismiss" || action === "notifications_sync_clear") return "notifications:write";
  if (action.startsWith("notifications_")) return action === "notifications_list" ? "notifications:read" : "notifications:write";
  if (action === "onboarding_status") return "account:read";
  if (action === "device_activity_report" || action === "device_command_result") return "devices:write";
  if (action === "device_activity_latest" || action === "device_self" || action === "device_list" || action === "reminders_list" || action === "device_commands_poll") return "devices:read";
  // Cross-account links: a paired device may create/claim/list/revoke links it
  // is part of, within the same device scope it already holds.
  if (action === "device_link_list" || action === "device_link_history") return "devices:read";
  // The inspected device reads its own notice and can always stop a session.
  if (action === "inspection_active") return "devices:read";
  if (action === "inspection_acknowledge" || action === "inspection_stop") return "devices:write";
  if (action === "device_link_invite_create" || action === "device_link_claim" || action === "device_link_revoke") return "devices:write";
  if (action === "reminders_create" || action === "reminders_complete") return "notifications:write";
  if (action === "device_command_queue") return "devices:control";
  if (action === "mirror_session_create" || action === "mirror_session_signals" || action === "mirror_sessions_list") return "mirror:view";
  if (action === "mirror_session_respond") return "mirror:share";
  if (action === "mirror_session_signal" || action === "mirror_session_stop") return "mirror:view";
  if (action === "family_activity_report") return "family:report";
  if (action === "family_mirror_frame_upload" || action === "family_mirror_active" || action === "family_mirror_consent" || action === "family_mirror_stop") return "family:mirror";
  if (action === "family_list" || action === "family_overview" || action === "family_request_parent_access") return "family:read";
  return null;
}
