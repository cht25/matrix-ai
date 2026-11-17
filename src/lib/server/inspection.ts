// =============================================================================
// QORVYNA — transparent device inspection (Phase 8).
//
// The invariants, all enforced server-side:
//
//   1. NOTHING STARTS SILENTLY. Creating a request only records intent; the
//      session becomes `active` when the TARGET device acknowledges the visible
//      notice. If the device never acknowledges, nothing is inspected.
//   2. GUARDIAN FIRST. On a guardian-protected account a verified guardian must
//      approve BEFORE the device is even asked. The guardian is found through
//      the real verified parent link — never an e-mail typed into a form.
//   3. TIME BOXED. `ends_at` is computed from a capped duration; the server
//      treats an expired session as over even if nobody closed it.
//   4. STOPPABLE. The device owner (or the guardian who approved) can end the
//      session; the next acknowledgement sees `revoked` and stops.
//   5. NOTHING SECRET IS IN SCOPE. `FORBIDDEN_SCOPES` is rejected at creation,
//      and the result payload may only carry the allowed scope keys.
//   6. EVERY STEP IS AUDITED and both accounts are notified in-app.
// =============================================================================

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { hasAdminCode } from "@/lib/admin-rbac";
import { getAdminPermissions } from "@/lib/server/queries";
import { isAdmin } from "@/lib/server/rpc";
import { getVerifiedParentsForUser } from "@/lib/server/parent-policy";
import {
  INSPECTION_MAX_MINUTES,
  STATUS_TEXT,
  validateRequest,
  type InspectionRequest,
  type InspectionScope,
  type InspectionStatus,
} from "@/lib/inspection";

const REQUESTS = "inspection_requests";
const EVENTS = "inspection_events";
const AUDIT = "admin_audit_log";
const NOTIFICATIONS = "notifications";

function millis(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const ts = value as { toMillis?: () => number; toDate?: () => Date; _seconds?: number } | null | undefined;
  if (typeof ts?.toMillis === "function") return ts.toMillis();
  if (typeof ts?.toDate === "function") return ts.toDate().getTime();
  // Firestore timestamps serialised as plain objects carry seconds AND
  // nanoseconds; ignoring the nanoseconds silently truncates to whole seconds.
  if (typeof ts?._seconds === "number") {
    const nanos = typeof (ts as { _nanoseconds?: number })._nanoseconds === "number" ? (ts as { _nanoseconds: number })._nanoseconds : 0;
    return ts._seconds * 1000 + Math.floor(nanos / 1e6);
  }
  return 0;
}

function iso(value: unknown): string {
  const ms = millis(value);
  return ms > 0 ? new Date(ms).toISOString() : "";
}

function toRequest(id: string, data: Record<string, unknown>): InspectionRequest {
  return {
    id,
    admin_uid: String(data.admin_uid ?? ""),
    admin_name: String(data.admin_name ?? ""),
    admin_email: String(data.admin_email ?? ""),
    target_uid: String(data.target_uid ?? ""),
    device_id: String(data.device_id ?? ""),
    reason: String(data.reason ?? ""),
    scopes: (Array.isArray(data.scopes) ? data.scopes.filter((s): s is InspectionScope => typeof s === "string") : []) as InspectionScope[],
    minutes: Number(data.minutes) || 0,
    status: String(data.status ?? "requested") as InspectionStatus,
    created_at: iso(data.created_at),
    starts_at: iso(data.starts_at),
    ends_at: iso(data.ends_at),
    ended_at: iso(data.ended_at),
    guardian_required: data.guardian_required === true,
    guardian_uid: typeof data.guardian_uid === "string" ? data.guardian_uid : null,
    stopped_by: typeof data.stopped_by === "string" ? data.stopped_by : null,
  };
}

/** A request that ran out of time is over, whatever field says otherwise. */
function effectiveStatus(request: InspectionRequest, nowMs: number): InspectionStatus {
  const terminal: InspectionStatus[] = ["ended", "denied", "expired", "revoked"];
  if (terminal.includes(request.status)) return request.status;
  const ends = millis(request.ends_at);
  if (ends && nowMs > ends) return "expired";
  return request.status;
}

async function notify(d: Db, uid: string, payload: Record<string, unknown>): Promise<void> {
  if (!uid) return;
  await d.collection(NOTIFICATIONS).add({
    user_id: uid,
    read_at: null,
    created_at: nowTs(),
    ...payload,
  });
}

async function audit(d: Db, request: InspectionRequest, action: string, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
  await d.collection(EVENTS).add({
    request_id: request.id,
    action,
    actor_id: actor,
    detail,
    created_at: nowTs(),
  });
  await d.collection(AUDIT).add({
    actor_id: actor,
    action: `inspection.${action}`,
    target_type: "inspection",
    target_id: request.id,
    target_owner: request.target_uid,
    reason: request.reason,
    created_at: nowTs(),
  });
}

// ---------------------------------------------------------------------------
// Admin: request
// ---------------------------------------------------------------------------

export async function requestInspection(
  d: Db,
  admin: SessionUser,
  input: { target_uid: string; device_id: string; reason: string; scopes: unknown; minutes: unknown },
): Promise<InspectionRequest> {
  if (!(await isAdmin(d, admin.uid))) throw new RpcError("FORBIDDEN", 403);
  const codes = await getAdminPermissions(d, admin.uid);
  // Inspecting a device is a privacy action — it needs the privacy grant code,
  // not merely "can view the admin panel".
  if (!hasAdminCode(codes, "privacy.access")) throw new RpcError("FORBIDDEN", 403);

  const checked = validateRequest(input);
  if (!checked.ok) throw new RpcError("INVALID_INSPECTION", 400, checked.error);

  const targetUid = String(input.target_uid ?? "");
  if (!targetUid) throw new RpcError("TARGET_REQUIRED", 400);

  // The device must exist and belong to the target — a typo must not point the
  // inspection at somebody else's hardware.
  const deviceSnap = await d.collection("devices").doc(String(input.device_id ?? "")).get();
  if (!deviceSnap.exists) throw new RpcError("NOT_FOUND", 404);
  if (deviceSnap.data()!.user_id !== targetUid) throw new RpcError("DEVICE_OWNER_MISMATCH", 400);

  // One live session per device: a second request while one is running would
  // make the on-screen indicator ambiguous.
  const live = await d.collection(REQUESTS).where("device_id", "==", input.device_id).get();
  const nowMs = Date.now();
  for (const doc of live.docs) {
    const existing = toRequest(doc.id, doc.data() as Record<string, unknown>);
    const status = effectiveStatus(existing, nowMs);
    if (status === "active" || status === "approved" || status === "awaiting_guardian" || status === "requested") {
      throw new RpcError("INSPECTION_ALREADY_ACTIVE", 409);
    }
  }

  // Guardian-protected accounts must have a VERIFIED guardian approve first.
  const guardians = await getVerifiedParentsForUser(d, targetUid);
  const guardianRequired = guardians.length > 0;
  const initialStatus: InspectionStatus = guardianRequired ? "awaiting_guardian" : "requested";

  const ref = d.collection(REQUESTS).doc();
  const request: InspectionRequest = {
    id: ref.id,
    admin_uid: admin.uid,
    admin_name: String((admin as { name?: string }).name ?? admin.email ?? ""),
    admin_email: admin.email ?? "",
    target_uid: targetUid,
    device_id: String(input.device_id),
    reason: checked.reason,
    scopes: checked.scopes,
    minutes: checked.minutes,
    status: initialStatus,
    created_at: new Date(nowMs).toISOString(),
    starts_at: "",
    // The clock only starts when the device acknowledges, so a request that
    // waits overnight cannot consume its window unseen.
    ends_at: "",
    ended_at: "",
    guardian_required: guardianRequired,
    guardian_uid: null,
    stopped_by: null,
  };

  await ref.set({
    admin_uid: request.admin_uid,
    admin_name: request.admin_name,
    admin_email: request.admin_email,
    target_uid: targetUid,
    device_id: request.device_id,
    reason: request.reason,
    scopes: request.scopes,
    minutes: request.minutes,
    status: initialStatus,
    created_at: nowTs(),
    starts_at: null,
    ends_at: null,
    ended_at: null,
    guardian_required: guardianRequired,
    guardian_uid: null,
    stopped_by: null,
  });

  await audit(d, request, "requested", admin.uid, { scopes: request.scopes, minutes: request.minutes, guardian_required: guardianRequired });

  if (guardianRequired) {
    for (const guardian of guardians) {
      await notify(d, guardian.parent_uid, {
        type: "inspection_guardian_approval",
        title: "Approval needed: device inspection",
        body: `${request.admin_name || "A QORVYNA administrator"} asked to inspect a device on this account. Reason: ${request.reason}`,
        inspection_id: request.id,
        action_url: "/guardian/inspections",
      });
    }
  } else {
    // The target is told immediately — inspection is never a surprise.
    await notify(d, targetUid, {
      type: "inspection_requested",
      title: "Inspection requested",
      body: `${request.admin_name || "An administrator"} requests to inspect diagnostics on your device. Reason: ${request.reason}. Nothing starts until you confirm on the device.`,
      inspection_id: request.id,
      action_url: "/devices",
    });
  }

  return request;
}

// ---------------------------------------------------------------------------
// Guardian: approve / decline
// ---------------------------------------------------------------------------

export async function decideInspectionAsGuardian(
  d: Db,
  guardian: SessionUser,
  input: { inspection_id: string; approve: boolean; note?: string },
): Promise<InspectionRequest> {
  const ref = d.collection(REQUESTS).doc(input.inspection_id);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const request = toRequest(snap.id, snap.data() as Record<string, unknown>);
  if (request.status !== "awaiting_guardian") throw new RpcError("INSPECTION_NOT_WAITING", 409);

  // Must be a VERIFIED guardian of the target account — an e-mail address is
  // never enough, and the check is repeated here rather than trusted from the UI.
  const guardians = await getVerifiedParentsForUser(d, request.target_uid);
  if (!guardians.some((entry) => entry.parent_uid === guardian.uid)) throw new RpcError("FORBIDDEN", 403);

  if (!input.approve) {
    await ref.set({ status: "denied", guardian_uid: guardian.uid, ended_at: nowTs(), guardian_note: String(input.note ?? "").slice(0, 300) }, { merge: true });
    await audit(d, request, "guardian_denied", guardian.uid);
    await notify(d, request.admin_uid, {
      type: "inspection_denied",
      title: "Inspection declined",
      body: "The guardian declined this inspection. Nothing was inspected.",
      inspection_id: request.id,
    });
    return { ...request, status: "denied", guardian_uid: guardian.uid };
  }

  await ref.set({ status: "requested", guardian_uid: guardian.uid, guardian_approved_at: nowTs() }, { merge: true });
  await audit(d, request, "guardian_approved", guardian.uid);
  await notify(d, request.target_uid, {
    type: "inspection_requested",
    title: "Inspection requested",
    body: `Your guardian approved an inspection requested by ${request.admin_name || "an administrator"}. Reason: ${request.reason}. It only starts after you confirm on this device.`,
    inspection_id: request.id,
    action_url: "/devices",
  });
  return { ...request, status: "requested", guardian_uid: guardian.uid };
}

// ---------------------------------------------------------------------------
// Target device: acknowledge (this is what makes a session ACTIVE)
// ---------------------------------------------------------------------------

export async function acknowledgeInspection(
  d: Db,
  user: SessionUser,
  input: { inspection_id: string; device_id: string },
): Promise<{ status: InspectionStatus; notice: string; ends_at: string; scopes: InspectionScope[] }> {
  const ref = d.collection(REQUESTS).doc(input.inspection_id);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const request = toRequest(snap.id, snap.data() as Record<string, unknown>);
  if (request.target_uid !== user.uid) throw new RpcError("NOT_FOUND", 404);
  if (request.device_id !== input.device_id) throw new RpcError("WRONG_DEVICE", 409);

  const nowMs = Date.now();
  const status = effectiveStatus(request, nowMs);
  if (status === "awaiting_guardian") throw new RpcError("GUARDIAN_APPROVAL_REQUIRED", 403);
  if (status === "denied" || status === "revoked" || status === "ended" || status === "expired") {
    return { status, notice: STATUS_TEXT[status], ends_at: request.ends_at, scopes: [] };
  }

  // Requests older than the same window expire before they can start.
  if (!request.starts_at && nowMs - millis(request.created_at) > INSPECTION_MAX_MINUTES * 60_000) {
    await ref.set({ status: "expired", ended_at: nowTs() }, { merge: true });
    return { status: "expired", notice: STATUS_TEXT.expired, ends_at: "", scopes: [] };
  }

  // Re-acknowledging an ALREADY active session must not extend it: a device
  // that polls acknowledgement could otherwise keep an inspection alive
  // forever. The window is fixed at the first acknowledgement.
  const existingEnds = millis(request.ends_at);
  if (request.status === "active" && existingEnds > 0) {
    return {
      status: "active",
      notice: STATUS_TEXT.active,
      ends_at: new Date(existingEnds).toISOString(),
      scopes: request.scopes,
    };
  }

  const endsAt = existingEnds || nowMs + Math.min(request.minutes, INSPECTION_MAX_MINUTES) * 60_000;
  const patch: Record<string, unknown> = {
    status: "active",
    ends_at: Timestamp.fromMillis(endsAt),
    acknowledged_at: nowTs(),
  };
  // Firestore rejects `undefined`, so only set the start time once.
  if (!request.starts_at) patch.starts_at = nowTs();
  await ref.set(patch, { merge: true });
  await audit(d, request, "activated", user.uid, { device_id: input.device_id });
  return {
    status: "active",
    notice: STATUS_TEXT.active,
    ends_at: new Date(endsAt).toISOString(),
    scopes: request.scopes,
  };
}

// ---------------------------------------------------------------------------
// Stop — by the device owner, the approving guardian, or the admin
// ---------------------------------------------------------------------------

export async function stopInspection(
  d: Db,
  user: SessionUser,
  input: { inspection_id: string; reason?: string },
): Promise<InspectionRequest> {
  const ref = d.collection(REQUESTS).doc(input.inspection_id);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const request = toRequest(snap.id, snap.data() as Record<string, unknown>);

  const allowed = user.uid === request.target_uid || user.uid === request.guardian_uid || user.uid === request.admin_uid;
  if (!allowed) throw new RpcError("NOT_FOUND", 404);
  if (["ended", "revoked", "denied", "expired"].includes(request.status)) return request;

  await ref.set(
    {
      status: "revoked",
      ended_at: nowTs(),
      ended_by: user.uid,
      stop_reason: String(input.reason ?? "").slice(0, 300),
    },
    { merge: true },
  );
  await audit(d, request, "revoked", user.uid, { reason: String(input.reason ?? "").slice(0, 300) });
  // Everyone involved is told, including the admin whose session was stopped.
  await notify(d, request.admin_uid, {
    type: "inspection_stopped",
    title: "Inspection stopped",
    body: "The inspection was stopped by the account or guardian. No further data is being collected.",
    inspection_id: request.id,
  });
  if (request.guardian_uid && request.guardian_uid !== user.uid) {
    await notify(d, request.guardian_uid, {
      type: "inspection_stopped",
      title: "Inspection stopped",
      body: "An inspection you approved has been stopped.",
      inspection_id: request.id,
    });
  }
  return { ...request, status: "revoked", stopped_by: user.uid };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What the target device shows: the newest non-terminal-or-active session. */
export async function activeInspectionFor(
  d: Db,
  user: SessionUser,
  deviceId: string,
): Promise<InspectionRequest | null> {
  const snap = await d.collection(REQUESTS).where("device_id", "==", deviceId).get();
  const nowMs = Date.now();
  const rows = snap.docs
    .map((doc) => toRequest(doc.id, doc.data() as Record<string, unknown>))
    .filter((row) => row.target_uid === user.uid)
    .map((row) => ({ row, status: effectiveStatus(row, nowMs) }))
    .filter(({ status }) => status === "active" || status === "requested" || status === "awaiting_guardian")
    .sort((a, b) => b.row.created_at.localeCompare(a.row.created_at));
  if (rows.length === 0) return null;
  return { ...rows[0].row, status: rows[0].status };
}

/** Admin view: one request plus its audit trail. */
export async function inspectionDetail(
  d: Db,
  admin: SessionUser,
  inspectionId: string,
): Promise<{ request: InspectionRequest; events: Array<{ action: string; at: string; actor_id: string }> }> {
  if (!(await isAdmin(d, admin.uid))) throw new RpcError("FORBIDDEN", 403);
  const codes = await getAdminPermissions(d, admin.uid);
  if (!hasAdminCode(codes, "privacy.access") && !hasAdminCode(codes, "security.view")) throw new RpcError("FORBIDDEN", 403);

  const snap = await d.collection(REQUESTS).doc(inspectionId).get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const request = toRequest(snap.id, snap.data() as Record<string, unknown>);
  const events = await d.collection(EVENTS).where("request_id", "==", inspectionId).limit(100).get();
  return {
    request: { ...request, status: effectiveStatus(request, Date.now()) },
    events: events.docs
      .map((doc) => ({
        action: String(doc.data().action ?? ""),
        at: iso(doc.data().created_at),
        actor_id: String(doc.data().actor_id ?? ""),
      }))
      .sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/** Everything a guardian has been asked about. */
export async function guardianInspectionQueue(d: Db, guardian: SessionUser): Promise<InspectionRequest[]> {
  const snap = await d.collection(REQUESTS).where("status", "==", "awaiting_guardian").get();
  const rows: InspectionRequest[] = [];
  for (const doc of snap.docs) {
    const request = toRequest(doc.id, doc.data() as Record<string, unknown>);
    const guardians = await getVerifiedParentsForUser(d, request.target_uid);
    if (guardians.some((entry) => entry.parent_uid === guardian.uid)) rows.push(request);
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
