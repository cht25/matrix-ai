// =============================================================================
// QORVYNA AI — Cross-Device Notification Ecosystem (server-only).
//
// Features:
//   - Syncs title, app name, optional body, timestamp, group key, device source.
//   - Privacy modes: `full` | `title_only` | `app_only` | `paused`.
//   - App exclusions checked BEFORE storage.
//   - Device isolation: unpaired, disconnected, or revoked devices NEVER
//     receive or ingest notifications.
//   - Dismissal syncs across devices and queues native cancel commands for
//     Android NotificationListenerService when supported.
//   - Integrates with Parent Notification Policy for protected notifications
//     and notification-access toggling.
// =============================================================================

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { evaluateAndHandleProtectedEvent } from "@/lib/server/parent-policy";
import { queueDeviceCommand } from "@/lib/server/device-actions";

const SYNCED = "synced_notifications";
const PREFS = "notification_preferences";
const DEVICES = "devices";
const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PrivacyMode = "full" | "title_only" | "app_only" | "paused";

export type NotificationPreferences = {
  user_id: string;
  sync_enabled: boolean;
  privacy_mode: PrivacyMode;
  redact_otp: boolean;
  excluded_apps: string[];
  allowed_target_device_ids: string[];
  updated_at: string;
};

export type SyncedNotificationItem = {
  id: string;
  source_device_id: string;
  source_device_name: string;
  source_platform: string;
  package_name: string;
  app_name: string;
  title: string;
  body: string;
  group_key: string;
  category: string;
  is_protected: boolean;
  external_key: string;
  posted_at: string;
  synced_at: string;
  read_at: string | null;
  dismissed_at: string | null;
};

const millis = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const ts = v as { toMillis?: () => number; _seconds?: number; seconds?: number } | null | undefined;
  if (typeof ts?.toMillis === "function") return Number(ts.toMillis());
  if (typeof ts?._seconds === "number") return ts._seconds * 1000;
  if (typeof ts?.seconds === "number") return ts.seconds * 1000;
  return 0;
};
const iso = (v: unknown): string => {
  const m = millis(v);
  return m ? new Date(m).toISOString() : "";
};
const cleanStr = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function redactOtpText(text: string): string {
  return text.replace(/\b(\d{4,8})\b/g, (match) => (match.length >= 4 ? "[CODE]" : match));
}

function normalizeExcluded(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => cleanStr(x, 120).toLowerCase()).filter(Boolean))].slice(0, 100);
}

function isExcludedApp(excluded: string[], packageName: string, appName: string): boolean {
  const pkg = packageName.toLowerCase();
  const app = appName.toLowerCase();
  return excluded.some((item) => item === pkg || item === app || (pkg && pkg.includes(item)));
}

async function verifyActiveDevice(d: Db, user: SessionUser, requiredScope?: string): Promise<{ id: string; device_name: string; platform: string } | null> {
  if (!user.deviceId) return null;
  const snap = await d.collection(DEVICES).doc(user.deviceId).get();
  if (!snap.exists) throw new RpcError("DEVICE_REVOKED", 403);
  const data = snap.data()!;
  if (data.user_id !== user.uid || data.revoked_at || data.suspended_at) {
    throw new RpcError("DEVICE_REVOKED", 403);
  }
  if (requiredScope && !(Array.isArray(data.scopes) && data.scopes.includes(requiredScope))) {
    throw new RpcError("DEVICE_SCOPE_DENIED", 403);
  }
  return {
    id: snap.id,
    device_name: cleanStr(data.device_name, 80) || "Paired device",
    platform: cleanStr(data.platform, 40) || "unknown",
  };
}

export async function getNotificationPreferences(d: Db, uid: string): Promise<NotificationPreferences> {
  const snap = await d.collection(PREFS).doc(uid).get();
  const data = snap.exists ? snap.data()! : {};
  const modeRaw = String(data.privacy_mode ?? "full");
  const privacy_mode: PrivacyMode =
    modeRaw === "title_only" || modeRaw === "app_only" || modeRaw === "paused" ? modeRaw : "full";
  return {
    user_id: uid,
    sync_enabled: data.sync_enabled === true,
    privacy_mode,
    redact_otp: data.redact_otp !== false,
    excluded_apps: normalizeExcluded(data.excluded_apps),
    allowed_target_device_ids: Array.isArray(data.allowed_target_device_ids)
      ? data.allowed_target_device_ids.map((x) => cleanStr(x, 128)).filter(Boolean)
      : [],
    updated_at: iso(data.updated_at),
  };
}

export async function updateNotificationPreferences(
  d: Db,
  user: SessionUser,
  input: {
    sync_enabled?: boolean;
    privacy_mode?: PrivacyMode;
    redact_otp?: boolean;
    excluded_apps?: string[];
    allowed_target_device_ids?: string[];
  },
): Promise<{ preferences: NotificationPreferences; policy_status?: string }> {
  if (user.deviceId) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
  const prev = await getNotificationPreferences(d, user.uid);
  const nextSync = typeof input.sync_enabled === "boolean" ? input.sync_enabled : prev.sync_enabled;
  const nextMode = input.privacy_mode ?? prev.privacy_mode;
  const nextRedact = typeof input.redact_otp === "boolean" ? input.redact_otp : prev.redact_otp;
  const nextExcluded = input.excluded_apps !== undefined ? normalizeExcluded(input.excluded_apps) : prev.excluded_apps;
  const nextTargets =
    input.allowed_target_device_ids !== undefined
      ? [...new Set(input.allowed_target_device_ids.map((x) => cleanStr(x, 128)).filter(Boolean))].slice(0, 50)
      : prev.allowed_target_device_ids;

  await d.collection(PREFS).doc(user.uid).set(
    {
      user_id: user.uid,
      sync_enabled: nextSync,
      privacy_mode: nextMode,
      redact_otp: nextRedact,
      excluded_apps: nextExcluded,
      allowed_target_device_ids: nextTargets,
      updated_at: nowTs(),
    },
    { merge: true },
  );

  let policy_status: string | undefined;
  if (!prev.sync_enabled && nextSync) {
    const res = await evaluateAndHandleProtectedEvent(d, user, {
      event_type: "notification_access_enabled",
      action_type: "enable_notification_sync",
      target_id: user.uid,
      summary: "Notification forwarding / cross-device sync was enabled on this account.",
    });
    policy_status = res.status;
  }

  return { preferences: await getNotificationPreferences(d, user.uid), ...(policy_status ? { policy_status } : {}) };
}

export async function ingestSyncedNotification(
  d: Db,
  user: SessionUser,
  input: {
    source_device_id?: string;
    source_device_name?: string;
    source_platform?: string;
    package_name: string;
    app_name: string;
    title: string;
    body?: string;
    group_key?: string;
    category?: string;
    is_protected?: boolean;
    external_key?: string;
    posted_at?: string;
  },
): Promise<{ synced: boolean; id?: string; reason?: string }> {
  const device = await verifyActiveDevice(d, user, "notifications:write");
  const prefs = await getNotificationPreferences(d, user.uid);

  if (!prefs.sync_enabled || prefs.privacy_mode === "paused") {
    return { synced: false, reason: "sync_paused" };
  }

  const packageName = cleanStr(input.package_name, 140);
  const appName = cleanStr(input.app_name, 80) || packageName || "App";
  if (isExcludedApp(prefs.excluded_apps, packageName, appName)) {
    return { synced: false, reason: "excluded_app" };
  }

  const rawTitle = cleanStr(input.title, 180);
  const rawBody = cleanStr(input.body ?? "", 600);
  let title = rawTitle || appName;
  let body = rawBody;

  if (prefs.privacy_mode === "app_only") {
    title = `Notification from ${appName}`;
    body = "";
  } else if (prefs.privacy_mode === "title_only") {
    body = "";
  } else if (prefs.redact_otp) {
    title = redactOtpText(title);
    body = redactOtpText(body);
  }

  const sourceId = device?.id ?? cleanStr(input.source_device_id, 128) ?? "web";
  const sourceName = device?.device_name ?? (cleanStr(input.source_device_name, 80) || "Connected device");
  const sourcePlatform = device?.platform ?? (cleanStr(input.source_platform, 40) || "web");
  const postedDate = input.posted_at ? new Date(input.posted_at) : new Date();
  const validPosted = Number.isNaN(postedDate.getTime()) ? new Date() : postedDate;

  const ref = d.collection(SYNCED).doc();
  await ref.set({
    user_id: user.uid,
    source_device_id: sourceId,
    source_device_name: sourceName,
    source_platform: sourcePlatform,
    package_name: packageName,
    app_name: appName,
    title,
    body,
    group_key: cleanStr(input.group_key, 120) || `${sourceId}:${packageName || appName}`,
    category: cleanStr(input.category, 40) || "general",
    is_protected: Boolean(input.is_protected),
    external_key: cleanStr(input.external_key, 240),
    posted_at: Timestamp.fromDate(validPosted),
    synced_at: nowTs(),
    read_at: null,
    dismissed_at: null,
    dismissed_by_device_id: null,
    expires_at: Timestamp.fromMillis(Date.now() + NOTIFICATION_TTL_MS),
  });

  return { synced: true, id: ref.id };
}

export async function listSyncedNotifications(
  d: Db,
  user: SessionUser,
  opts: { include_dismissed?: boolean; limit?: number } = {},
): Promise<{
  items: SyncedNotificationItem[];
  groups: Array<{ group_key: string; app_name: string; source_device_name: string; unread_count: number; items: SyncedNotificationItem[] }>;
  preferences: NotificationPreferences;
  unread_count: number;
  device_authorized: boolean;
}> {
  await verifyActiveDevice(d, user, "notifications:read");
  const prefs = await getNotificationPreferences(d, user.uid);

  // Device isolation: if target device allowlist is set, never expose to unlisted device.
  if (user.deviceId && prefs.allowed_target_device_ids.length > 0 && !prefs.allowed_target_device_ids.includes(user.deviceId)) {
    return { items: [], groups: [], preferences: prefs, unread_count: 0, device_authorized: false };
  }

  const snap = await d.collection(SYNCED).where("user_id", "==", user.uid).get();
  const nowMs = Date.now();
  const all: SyncedNotificationItem[] = snap.docs
    .filter((doc) => {
      const data = doc.data();
      if (!opts.include_dismissed && data.dismissed_at) return false;
      if (data.expires_at && millis(data.expires_at) <= nowMs) return false;
      return true;
    })
    .sort((a, b) => millis(b.data().synced_at) - millis(a.data().synced_at))
    .slice(0, Math.min(200, Math.max(10, opts.limit ?? 100)))
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        source_device_id: String(data.source_device_id ?? ""),
        source_device_name: String(data.source_device_name ?? ""),
        source_platform: String(data.source_platform ?? ""),
        package_name: String(data.package_name ?? ""),
        app_name: String(data.app_name ?? ""),
        title: String(data.title ?? ""),
        body: String(data.body ?? ""),
        group_key: String(data.group_key ?? ""),
        category: String(data.category ?? "general"),
        is_protected: Boolean(data.is_protected),
        external_key: String(data.external_key ?? ""),
        posted_at: iso(data.posted_at),
        synced_at: iso(data.synced_at),
        read_at: data.read_at ? iso(data.read_at) : null,
        dismissed_at: data.dismissed_at ? iso(data.dismissed_at) : null,
      };
    });

  const groupMap = new Map<string, { group_key: string; app_name: string; source_device_name: string; unread_count: number; items: SyncedNotificationItem[] }>();
  for (const item of all) {
    const key = item.group_key || item.app_name || "general";
    let group = groupMap.get(key);
    if (!group) {
      group = {
        group_key: key,
        app_name: item.app_name,
        source_device_name: item.source_device_name,
        unread_count: 0,
        items: [],
      };
      groupMap.set(key, group);
    }
    if (!item.read_at) group.unread_count += 1;
    group.items.push(item);
  }

  return {
    items: all,
    groups: [...groupMap.values()],
    preferences: prefs,
    unread_count: all.filter((i) => !i.read_at).length,
    device_authorized: true,
  };
}

export async function markSyncedNotificationRead(d: Db, user: SessionUser, input: { id?: string; all?: boolean }) {
  await verifyActiveDevice(d, user, "notifications:read");
  if (input.all) {
    const snap = await d.collection(SYNCED).where("user_id", "==", user.uid).get();
    await Promise.all(
      snap.docs.filter((doc) => !doc.data().read_at).map((doc) => doc.ref.set({ read_at: nowTs() }, { merge: true })),
    );
    return { ok: true };
  }
  if (!input.id) throw new RpcError("NOT_FOUND", 404);
  const ref = d.collection(SYNCED).doc(input.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  await ref.set({ read_at: nowTs() }, { merge: true });
  return { ok: true };
}

export async function dismissSyncedNotification(
  d: Db,
  user: SessionUser,
  input: { id: string },
): Promise<{ status: "dismissed" | "pending_approval"; request_id?: string; command_queued?: boolean }> {
  await verifyActiveDevice(d, user, "notifications:write");
  const ref = d.collection(SYNCED).doc(input.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;

  if (data.is_protected === true) {
    const outcome = await evaluateAndHandleProtectedEvent(d, user, {
      event_type: "protected_notification_dismissed",
      action_type: "dismiss_protected_notification",
      target_id: input.id,
      summary: `Requested dismissing protected notification "${String(data.title ?? data.app_name ?? "notification")}".`,
    });
    if (outcome.status === "pending_approval") {
      return { status: "pending_approval", request_id: outcome.request_id };
    }
  }

  await ref.set(
    {
      dismissed_at: nowTs(),
      read_at: data.read_at ?? nowTs(),
      dismissed_by_device_id: user.deviceId ?? "web",
    },
    { merge: true },
  );

  let command_queued = false;
  if (data.source_platform === "android" && data.source_device_id && data.external_key) {
    const queued = await queueDeviceCommand(d, user, {
      target_device_id: String(data.source_device_id),
      command: "dismiss_notification",
      args: { external_key: String(data.external_key), notification_id: input.id },
      requires_confirmation: false,
    }).catch(() => null);
    command_queued = Boolean(queued?.command_id);
  }

  return { status: "dismissed", command_queued };
}

export async function clearSyncedNotificationHistory(d: Db, user: SessionUser): Promise<{ cleared: number; held_protected: number }> {
  await verifyActiveDevice(d, user, "notifications:write");
  const snap = await d.collection(SYNCED).where("user_id", "==", user.uid).get();
  let cleared = 0;
  let held_protected = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.dismissed_at) continue;
    if (data.is_protected === true) {
      held_protected += 1;
      continue;
    }
    await doc.ref.set({ dismissed_at: nowTs(), dismissed_by_device_id: user.deviceId ?? "web" }, { merge: true });
    cleared += 1;
  }
  return { cleared, held_protected };
}
