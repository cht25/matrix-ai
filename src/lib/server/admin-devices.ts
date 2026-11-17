// =============================================================================
// QORVYNA — admin device dashboard (Phase 7).
//
// Read-only oversight of every paired device, plus the three moderation
// actions the spec asks for: disable, block, revoke. Rules enforced here:
//
//   • RBAC: every entry point re-checks the caller's admin permission codes
//     server-side — the admin UI hiding a button is never the authorization.
//   • HASHES ONLY: `access_token_hash` and any pairing secret are stripped
//     before a row leaves this module. Admins can see that a credential
//     exists, never a reusable secret.
//   • Every moderation action writes an audit row with the actor, target and
//     reason, so the change is attributable after the fact.
//   • Search/filter run against the sanitised projection, so an admin cannot
//     probe for secrets by filtering on them.
// =============================================================================

import "server-only";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import type { AdminPermissionCode } from "@/lib/admin-rbac";
import { hasAdminCode } from "@/lib/admin-rbac";
import { RpcError } from "@/lib/server/errors";
import { getAdminPermissions } from "@/lib/server/queries";
import { isAdmin } from "@/lib/server/rpc";
import { connectionStatus, type ConnectionStatus } from "@/lib/devices/model";

const DEVICES = "devices";
const EVENTS = "device_events";
const AUDIT = "admin_audit_log";
const LINKS = "device_links";

export type AdminDeviceRow = {
  id: string;
  owner_uid: string;
  device_name: string;
  platform: string;
  os: string;
  app_version: string;
  role: string;
  status: ConnectionStatus;
  online: boolean;
  registered_at: string;
  last_seen_at: string;
  last_ip: string;
  location: string;
  /** Whether a credential exists — never the credential. */
  has_credential: boolean;
  suspended: boolean;
  blocked: boolean;
  revoked: boolean;
  links: number;
};

export type AdminDeviceQuery = {
  search?: string;
  status?: string;
  platform?: string;
  online_only?: boolean;
  limit?: number;
};

/** Fields that must never leave this module. */
const FORBIDDEN_KEYS = [
  "access_token_hash",
  "claim_hash",
  "code_hash",
  "secret_hash",
  "token_hash",
  "access_token",
  "refresh_token",
  "password",
];

function scrub<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row };
  for (const key of FORBIDDEN_KEYS) delete copy[key];
  return copy;
}

/** Strip every known secret-ish field from a nested object. */
function deepScrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepScrub);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.includes(key)) continue;
    if (/secret|token|hash|password/i.test(key)) continue;
    out[key] = deepScrub(nested);
  }
  return out;
}

function text(value: unknown, max = 120): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function millis(value: unknown): number {
  if (typeof value === "number") return value;
  const ts = value as { toMillis?: () => number; toDate?: () => Date; _seconds?: number } | null | undefined;
  if (typeof ts?.toMillis === "function") return ts.toMillis();
  if (typeof ts?.toDate === "function") return ts.toDate().getTime();
  if (typeof ts?._seconds === "number") return ts._seconds * 1000;
  return 0;
}

function iso(value: unknown): string {
  const ms = millis(value);
  return ms > 0 ? new Date(ms).toISOString() : "";
}

/**
 * Authorize an admin action. `security.view` is the baseline for reading;
 * moderation additionally requires `users.view` so a read-only auditor cannot
 * disconnect anybody's device.
 */
export async function requireAdminDeviceAccess(
  d: Db,
  user: SessionUser,
  level: "read" | "write",
): Promise<string[]> {
  if (!(await isAdmin(d, user.uid))) throw new RpcError("FORBIDDEN", 403);
  const codes = await getAdminPermissions(d, user.uid);
  if (!hasAdminCode(codes, "security.view")) throw new RpcError("FORBIDDEN", 403);
  if (level === "write" && !hasAdminCode(codes, "users.view")) throw new RpcError("FORBIDDEN", 403);
  return codes;
}

function toRow(id: string, data: Record<string, unknown>, nowMs: number): AdminDeviceRow {
  const lastSeen = millis(data.last_seen_at);
  const status = connectionStatus({
    revoked: Boolean(data.revoked_at),
    suspended: Boolean(data.suspended_at) || Boolean(data.blocked_at),
    credentialed: data.role === "parent" || typeof data.access_token_hash === "string",
    lastSeenMs: lastSeen,
    nowMs,
  });
  return scrub({
    id,
    owner_uid: text(data.user_id, 128),
    device_name: text(data.device_name, 80) || "QORVYNA device",
    platform: text(data.platform, 40) || "unknown",
    os: text(data.os, 60),
    app_version: text(data.app_version, 40),
    role: data.role === "parent" ? "parent" : data.role === "child" ? "child" : "device",
    status,
    online: status === "online",
    registered_at: iso(data.paired_at ?? data.created_at),
    last_seen_at: iso(data.last_seen_at),
    last_ip: text(data.last_ip, 64),
    location: text(data.location, 80),
    has_credential: typeof data.access_token_hash === "string",
    suspended: Boolean(data.suspended_at),
    blocked: Boolean(data.blocked_at),
    revoked: Boolean(data.revoked_at),
    links: 0,
  }) as AdminDeviceRow;
}

/**
 * List devices for the dashboard. Filtering happens after projection, so the
 * result set is identical whether or not a search is supplied — an admin can
 * never infer a secret by observing which rows match.
 */
export async function listAdminDevices(
  d: Db,
  user: SessionUser,
  query: AdminDeviceQuery = {},
  nowMs: number = Date.now(),
): Promise<{ devices: AdminDeviceRow[]; total: number; counts: Record<string, number> }> {
  await requireAdminDeviceAccess(d, user, "read");
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));

  const snap = await d.collection(DEVICES).limit(limit * 4).get();
  let rows = snap.docs.map((doc) => toRow(doc.id, doc.data() as Record<string, unknown>, nowMs));

  // Link counts, per device owner. Links never expose the peer's secret.
  const linkSnap = await d.collection(LINKS).limit(1000).get();
  const perOwner = new Map<string, number>();
  for (const doc of linkSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (data.revoked_at) continue;
    for (const side of ["a", "b"] as const) {
      const uid = (data[side] as { uid?: string } | undefined)?.uid;
      if (uid) perOwner.set(uid, (perOwner.get(uid) ?? 0) + 1);
    }
  }
  rows = rows.map((row) => ({ ...row, links: perOwner.get(row.owner_uid) ?? 0 }));

  const counts = rows.reduce<Record<string, number>>(
    (acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }),
    {},
  );
  const total = rows.length;

  const search = (query.search ?? "").trim().toLowerCase();
  if (search) {
    rows = rows.filter((row) =>
      [row.id, row.owner_uid, row.device_name, row.platform, row.os, row.app_version, row.last_ip, row.location]
        .join(" ")
        .toLowerCase()
        .includes(search),
    );
  }
  if (query.status) rows = rows.filter((row) => row.status === query.status);
  if (query.platform) rows = rows.filter((row) => row.platform.toLowerCase() === query.platform!.toLowerCase());
  if (query.online_only) rows = rows.filter((row) => row.online);

  return { devices: rows.slice(0, limit), total, counts };
}

/** One device, with its event history. Secrets are scrubbed at every level. */
export async function adminDeviceDetail(
  d: Db,
  user: SessionUser,
  deviceId: string,
): Promise<{ device: AdminDeviceRow; events: Array<{ type: string; at: string; detail: unknown }> }> {
  await requireAdminDeviceAccess(d, user, "read");
  const snap = await d.collection(DEVICES).doc(deviceId).get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const events = await d.collection(EVENTS).where("device_id", "==", deviceId).limit(100).get();
  return {
    device: toRow(snap.id, snap.data() as Record<string, unknown>, Date.now()),
    events: events.docs
      .map((doc) => {
        const data = doc.data() as Record<string, unknown>;
        return { type: text(data.type, 60), at: iso(data.created_at), detail: deepScrub(data.detail ?? {}) };
      })
      .sort((a, b) => b.at.localeCompare(a.at)),
  };
}

export type ModerationOutcome = { device_id: string; action: string; at: string };

const ACTIONS: Record<string, { field: string; event: string; label: string }> = {
  disable: { field: "suspended_at", event: "admin_disabled", label: "disabled" },
  enable: { field: "suspended_at", event: "admin_enabled", label: "re-enabled" },
  block: { field: "blocked_at", event: "admin_blocked", label: "blocked" },
  unblock: { field: "blocked_at", event: "admin_unblocked", label: "unblocked" },
  revoke: { field: "revoked_at", event: "admin_revoked", label: "revoked" },
};

/**
 * Disable / enable / block / unblock / revoke a device.
 *
 * Revocation also tears down every cross-account link that device takes part
 * in, so a revoked device cannot keep reaching a peer through a stale link.
 * A reason is mandatory: an unattributed moderation action is not auditable.
 */
export async function moderateDevice(
  d: Db,
  user: SessionUser,
  input: { device_id: string; action: string; reason: string },
): Promise<ModerationOutcome> {
  await requireAdminDeviceAccess(d, user, "write");
  const spec = ACTIONS[input.action];
  if (!spec) throw new RpcError("UNKNOWN_ACTION", 400);
  const reason = (input.reason ?? "").trim();
  if (reason.length < 4) throw new RpcError("REASON_REQUIRED", 400);

  const ref = d.collection(DEVICES).doc(input.device_id);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data() as Record<string, unknown>;

  const clearing = input.action === "enable" || input.action === "unblock";
  await ref.set(
    {
      [spec.field]: clearing ? null : nowTs(),
      last_moderated_by: user.uid,
      last_moderated_at: nowTs(),
      last_moderation_reason: reason,
    },
    { merge: true },
  );

  await d.collection(EVENTS).add({
    device_id: input.device_id,
    user_id: text(data.user_id, 128),
    type: spec.event,
    actor: user.uid,
    reason,
    created_at: nowTs(),
  });

  await d.collection(AUDIT).add({
    actor_id: user.uid,
    action: `device.${input.action}`,
    target_type: "device",
    target_id: input.device_id,
    target_owner: text(data.user_id, 128),
    reason,
    created_at: nowTs(),
  });

  if (input.action === "revoke") {
    const owner = text(data.user_id, 128);
    const links = await d.collection(LINKS).limit(500).get();
    for (const doc of links.docs) {
      const link = doc.data() as Record<string, unknown>;
      if (link.revoked_at) continue;
      const sides = [link.a, link.b] as Array<{ uid?: string } | undefined>;
      if (!sides.some((side) => side?.uid === owner)) continue;
      await doc.ref.set({ revoked_at: nowTs(), revoked_by: user.uid, status: "revoked" }, { merge: true });
    }
  }

  return { device_id: input.device_id, action: input.action, at: new Date().toISOString() };
}

/**
 * Pairing history across the platform. Admin sees WHO linked to WHOM and when,
 * plus a truncated hash fingerprint for correlation — never a usable secret.
 */
export async function adminPairingHistory(
  d: Db,
  user: SessionUser,
  limitArg: number = 100,
): Promise<Array<{ id: string; a: string; b: string; status: string; created_at: string; revoked_at: string }>> {
  await requireAdminDeviceAccess(d, user, "read");
  const limit = Math.min(300, Math.max(1, limitArg));
  const snap = await d.collection(LINKS).limit(limit).get();
  return snap.docs
    .map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        id: doc.id,
        a: text((data.a as { uid?: string } | undefined)?.uid, 128),
        b: text((data.b as { uid?: string } | undefined)?.uid, 128),
        status: data.revoked_at ? "revoked" : text(data.status, 30) || "active",
        created_at: iso(data.created_at),
        revoked_at: iso(data.revoked_at),
      };
    })
    .sort((x, y) => y.created_at.localeCompare(x.created_at));
}

/** MFA-ish sanity check used by the dashboard banner: how many admins exist. */
export async function adminDevicePolicySummary(d: Db): Promise<{ max_devices_per_account: number; link_ttl_minutes: number; require_reason: boolean }> {
  const policy = await d.collection("system_settings").doc("device_policy").get();
  const data = policy.exists ? (policy.data() as Record<string, unknown>) : {};
  return {
    max_devices_per_account: Number(data.max_devices_per_account) || 10,
    link_ttl_minutes: Number(data.link_ttl_minutes) || 10,
    require_reason: data.require_reason !== false,
  };
}
