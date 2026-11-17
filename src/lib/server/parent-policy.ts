// =============================================================================
// QORVYNA AI — Verified Parent Relationship, Policy Engine & Protected Approvals.
//
// Security guarantees:
//   1. A user CANNOT register an arbitrary parent email and silently treat it
//      as a verified guardian. Parent links start as `pending_verification` and
//      only become `verified` after the target parent signs in with that email
//      and explicitly confirms the relationship with the hashed one-time token.
//   2. Protected action emails NEVER auto-approve the action. The request stays
//      in `pending_approval` until the verified parent explicitly calls
//      `decideProtectedAction` (approve / deny).
//   3. Anti-spam cooldown deduplicates rapid repeated notifications per event.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { siteOrigin } from "@/lib/seo";
import {
  configuredParentNotificationEmail,
  maskEmail,
  sendParentNotificationEmail,
  sendProtectedActionApprovalEmail,
  sendVerificationNoticeEmail,
} from "@/lib/server/email";

const PARENT_LINKS = "parent_links";
const PARENT_POLICIES = "parent_policies";
const PROTECTED_ACTIONS = "protected_action_requests";
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const POLICY_EVENT_TYPES = [
  "notification_access_enabled",
  "protected_notification_dismissed",
  "policy_disabled",
  "device_unpaired",
  "critical_permission_revoked",
] as const;

export type PolicyEventType = (typeof POLICY_EVENT_TYPES)[number];

export type PolicyRule = {
  enabled: boolean;
  require_parent_approval: boolean;
  cooldown_minutes: number;
};

export type ParentPolicyConfig = {
  user_id: string;
  rules: Record<PolicyEventType, PolicyRule>;
  updated_at: string;
};

export function defaultPolicyRules(): Record<PolicyEventType, PolicyRule> {
  return {
    notification_access_enabled: { enabled: true, require_parent_approval: false, cooldown_minutes: 30 },
    protected_notification_dismissed: { enabled: true, require_parent_approval: true, cooldown_minutes: 10 },
    policy_disabled: { enabled: true, require_parent_approval: true, cooldown_minutes: 10 },
    device_unpaired: { enabled: true, require_parent_approval: true, cooldown_minutes: 10 },
    critical_permission_revoked: { enabled: true, require_parent_approval: false, cooldown_minutes: 15 },
  };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function millis(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const ts = value as { toMillis?: () => number; _seconds?: number; seconds?: number } | undefined;
  if (typeof ts?.toMillis === "function") return Number(ts.toMillis());
  if (typeof ts?._seconds === "number") return ts._seconds * 1000;
  if (typeof ts?.seconds === "number") return ts.seconds * 1000;
  return 0;
}

function iso(value: unknown): string {
  const ms = millis(value);
  return ms ? new Date(ms).toISOString() : "";
}

async function audit(d: Db, actor: string, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
  try {
    await d.collection("audit_logs").add({
      actor_id: actor,
      action,
      target_type: "parent_policy",
      target_id: targetId,
      reason: "",
      metadata,
      created_at: nowTs(),
    });
  } catch {
    /* non-fatal */
  }
}

async function inAppNotify(d: Db, uid: string, input: { title: string; body: string; link: string }) {
  try {
    await d.collection("notifications").add({
      user_id: uid,
      type: "parent_policy",
      title: input.title,
      body: input.body,
      link: input.link,
      read_at: null,
      delivery_channel: "in_app",
      created_at: nowTs(),
    });
  } catch {
    /* non-fatal */
  }
}

export function sanitizePolicyRules(raw: unknown): Record<PolicyEventType, PolicyRule> {
  const base = defaultPolicyRules();
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Record<string, unknown>;
  for (const key of POLICY_EVENT_TYPES) {
    const entry = record[key];
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    base[key] = {
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : base[key].enabled,
      require_parent_approval:
        typeof obj.require_parent_approval === "boolean" ? obj.require_parent_approval : base[key].require_parent_approval,
      cooldown_minutes:
        typeof obj.cooldown_minutes === "number" && Number.isFinite(obj.cooldown_minutes)
          ? Math.max(1, Math.min(1440, Math.round(obj.cooldown_minutes)))
          : base[key].cooldown_minutes,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Verified Parent Links
// ---------------------------------------------------------------------------

export async function requestParentLink(
  d: Db,
  childUser: SessionUser,
  input: { parent_email: string; relationship_label?: string },
): Promise<{
  link_id: string;
  status: "pending_verification";
  parent_email_masked: string;
  expires_at: string;
  email_status: string;
  /** Token is only returned to the requester when testing or in-app handoff? NO —
   * never return the verification token to the child so the child cannot
   * self-verify without the parent receiving & opening it! Only return `email_status`. */
}> {
  if (childUser.deviceId) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
  const parentEmail = input.parent_email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)) throw new RpcError("INVALID_EMAIL", 400);
  if (childUser.email && childUser.email.trim().toLowerCase() === parentEmail) {
    throw new RpcError("CANNOT_SELF_PARENT", 400);
  }

  // Prevent flooding verification requests.
  const existing = await d.collection(PARENT_LINKS).where("child_uid", "==", childUser.uid).get();
  const activeCount = existing.docs.filter((doc) => {
    const st = doc.data()?.status;
    return st === "verified" || (st === "pending_verification" && millis(doc.data()?.expires_at) > Date.now());
  }).length;
  if (activeCount >= 5) throw new RpcError("PARENT_LINK_LIMIT", 429);

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresMs = Date.now() + LINK_TTL_MS;
  const ref = d.collection(PARENT_LINKS).doc();
  await ref.set({
    child_uid: childUser.uid,
    child_email_masked: childUser.email ? maskEmail(childUser.email) : "",
    parent_uid: null,
    parent_email: parentEmail,
    parent_email_masked: maskEmail(parentEmail),
    relationship_label: (input.relationship_label ?? "Parent / Guardian").trim().slice(0, 48),
    status: "pending_verification",
    token_hash: sha256(token),
    expires_at: Timestamp.fromMillis(expiresMs),
    verified_at: null,
    revoked_at: null,
    created_at: nowTs(),
  });

  const verifyUrl = `${siteOrigin()}/family#verify_parent=${encodeURIComponent(token)}`;
  const mail = await sendVerificationNoticeEmail({
    db: d,
    userId: childUser.uid,
    email: parentEmail,
    purpose: "parent_relationship",
    verifyUrl,
  });

  await audit(d, childUser.uid, "parent_link.requested", ref.id, {
    parent_email_masked: maskEmail(parentEmail),
    email_status: mail.status,
  });

  return {
    link_id: ref.id,
    status: "pending_verification",
    parent_email_masked: maskEmail(parentEmail),
    expires_at: new Date(expiresMs).toISOString(),
    email_status: mail.status,
  };
}

/**
 * Only an authenticated user with a verified email matching `parent_email` can
 * confirm the parent-child relationship using the one-time token.
 */
export async function verifyParentLink(
  d: Db,
  parentActor: SessionUser,
  input: { token: string },
): Promise<{ link_id: string; status: "verified"; child_uid: string }> {
  if (parentActor.deviceId) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
  const rawToken = input.token.trim();
  if (rawToken.length < 16) throw new RpcError("INVALID_TOKEN", 400);
  const tokenHash = sha256(rawToken);

  const matchSnap = await d.collection(PARENT_LINKS).where("token_hash", "==", tokenHash).get();
  if (matchSnap.empty) throw new RpcError("PARENT_LINK_INVALID", 404);
  const targetDoc = matchSnap.docs[0];

  let childUid = "";
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(d.collection(PARENT_LINKS).doc(targetDoc.id));
    if (!snap.exists) throw new RpcError("PARENT_LINK_INVALID", 404);
    const data = snap.data()!;
    if (data.status !== "pending_verification") throw new RpcError("PARENT_LINK_ALREADY_USED", 409);
    if (millis(data.expires_at) <= Date.now()) {
      tx.set(snap.ref, { status: "expired" }, { merge: true });
      throw new RpcError("PARENT_LINK_EXPIRED", 410);
    }
    const actorEmail = (parentActor.email ?? "").trim().toLowerCase();
    if (!parentActor.emailVerified || !actorEmail || actorEmail !== String(data.parent_email ?? "").toLowerCase()) {
      throw new RpcError("PARENT_EMAIL_MISMATCH", 403);
    }
    if (data.child_uid === parentActor.uid) throw new RpcError("CANNOT_SELF_PARENT", 400);
    childUid = String(data.child_uid);
    tx.set(
      snap.ref,
      {
        status: "verified",
        parent_uid: parentActor.uid,
        verified_at: nowTs(),
        token_hash: null,
      },
      { merge: true },
    );
  });

  await audit(d, parentActor.uid, "parent_link.verified", targetDoc.id, { child_uid: childUid });
  await inAppNotify(d, childUid, {
    title: "Parent relationship verified",
    body: "Your parent/guardian confirmed their link. Parent notification policies are now active.",
    link: "/family",
  });

  return { link_id: targetDoc.id, status: "verified", child_uid: childUid };
}

/** Collect verified parent links for a child UID (never includes unverified links!). */
export async function getVerifiedParentsForUser(
  d: Db,
  childUid: string,
): Promise<Array<{ link_id: string; parent_uid: string; parent_email: string }>> {
  const snap = await d.collection(PARENT_LINKS).where("child_uid", "==", childUid).get();
  return snap.docs
    .filter((doc) => doc.data()?.status === "verified" && !doc.data()?.revoked_at && typeof doc.data()?.parent_uid === "string")
    .map((doc) => ({
      link_id: doc.id,
      parent_uid: String(doc.data()!.parent_uid),
      parent_email: String(doc.data()!.parent_email ?? ""),
    }));
}

export async function getParentPolicy(d: Db, uid: string): Promise<ParentPolicyConfig> {
  const snap = await d.collection(PARENT_POLICIES).doc(uid).get();
  const data = snap.exists ? snap.data() : undefined;
  return {
    user_id: uid,
    rules: sanitizePolicyRules(data?.rules),
    updated_at: iso(data?.updated_at),
  };
}

/**
 * Update parent policy rules. If a verified parent exists AND `policy_disabled`
 * currently requires parent approval, a child attempting to weaken/disable
 * any rule is held as a protected action requiring explicit parent approval.
 */
export async function updateParentPolicy(
  d: Db,
  actor: SessionUser,
  input: { target_uid?: string; rules: unknown },
): Promise<
  | { status: "updated"; policy: ParentPolicyConfig }
  | { status: "pending_approval"; request_id: string; policy: ParentPolicyConfig }
> {
  if (actor.deviceId) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
  const targetUid = input.target_uid?.trim() || actor.uid;
  const verifiedParents = await getVerifiedParentsForUser(d, targetUid);
  const isVerifiedParent = verifiedParents.some((p) => p.parent_uid === actor.uid);

  if (targetUid !== actor.uid && !isVerifiedParent) {
    throw new RpcError("PERMISSION_DENIED", 403);
  }

  const current = await getParentPolicy(d, targetUid);
  const nextRules = sanitizePolicyRules(input.rules);

  // Detect if the child is disabling or relaxing a policy while a verified parent enforces it.
  if (targetUid === actor.uid && !isVerifiedParent && verifiedParents.length > 0) {
    const weakensRule = POLICY_EVENT_TYPES.some((k) => {
      const prev = current.rules[k];
      const next = nextRules[k];
      return (prev.enabled && !next.enabled) || (prev.require_parent_approval && !next.require_parent_approval);
    });
    if (weakensRule && current.rules.policy_disabled.require_parent_approval) {
      const outcome = await evaluateAndHandleProtectedEvent(d, actor, {
        event_type: "policy_disabled",
        action_type: "update_parent_policy",
        target_id: targetUid,
        summary: "Child requested disabling or relaxing parent notification policy rules.",
        payload: { rules: nextRules },
      });
      if (outcome.status === "pending_approval" && outcome.request_id) {
        return { status: "pending_approval", request_id: outcome.request_id, policy: current };
      }
    }
  }

  await d.collection(PARENT_POLICIES).doc(targetUid).set(
    {
      user_id: targetUid,
      rules: nextRules,
      updated_by: actor.uid,
      updated_at: nowTs(),
    },
    { merge: true },
  );
  await audit(d, actor.uid, "parent_policy.updated", targetUid, { by_parent: isVerifiedParent });
  return { status: "updated", policy: await getParentPolicy(d, targetUid) };
}

/**
 * Core policy evaluator for protected events:
 *   1. Records event and audit log.
 *   2. Applies anti-spam cooldown before sending emails.
 *   3. If `require_parent_approval` is true and a verified parent exists,
 *      creates `protected_action_requests` in `pending_approval` and emails
 *      the verified parent — NEVER auto-approves on email send.
 */
export async function evaluateAndHandleProtectedEvent(
  d: Db,
  user: SessionUser,
  input: {
    event_type: PolicyEventType;
    action_type: string;
    target_id: string;
    summary: string;
    payload?: Record<string, unknown>;
  },
): Promise<{
  allowed: boolean;
  status: "no_parent_policy" | "disabled_by_policy" | "notified" | "cooldown_suppressed" | "pending_approval";
  request_id?: string;
}> {
  const verifiedParents = await getVerifiedParentsForUser(d, user.uid);
  if (verifiedParents.length === 0) {
    await audit(d, user.uid, `policy.${input.event_type}.unsupervised`, input.target_id, { action_type: input.action_type });
    return { allowed: true, status: "no_parent_policy" };
  }

  const policy = await getParentPolicy(d, user.uid);
  const rule = policy.rules[input.event_type];
  if (!rule?.enabled) {
    await audit(d, user.uid, `policy.${input.event_type}.rule_off`, input.target_id, { action_type: input.action_type });
    return { allowed: true, status: "disabled_by_policy" };
  }

  const primaryParent = verifiedParents[0];

  if (rule.require_parent_approval) {
    const expiresMs = Date.now() + APPROVAL_TTL_MS;
    const reqRef = d.collection(PROTECTED_ACTIONS).doc();
    await reqRef.set({
      user_id: user.uid,
      parent_uid: primaryParent.parent_uid,
      parent_email_masked: maskEmail(primaryParent.parent_email),
      event_type: input.event_type,
      action_type: input.action_type,
      target_id: input.target_id,
      summary: input.summary.slice(0, 400),
      payload: input.payload ?? {},
      status: "pending_approval",
      execution_status: "held",
      email_delivery_status: "pending",
      decided_by: null,
      decided_at: null,
      decision_reason: "",
      expires_at: Timestamp.fromMillis(expiresMs),
      created_at: nowTs(),
    });

    await inAppNotify(d, primaryParent.parent_uid, {
      title: "Parent approval needed",
      body: input.summary,
      link: `/family?approval=${reqRef.id}`,
    });

    const approvalUrl = `${siteOrigin()}/family#approval=${encodeURIComponent(reqRef.id)}`;
    const mail = await sendProtectedActionApprovalEmail({
      db: d,
      userId: user.uid,
      parentEmail: primaryParent.parent_email,
      requestId: reqRef.id,
      actionTitle: input.event_type.replace(/_/g, " "),
      detail: input.summary,
      approvalUrl,
    });

    // IMPORTANT: Email acceptance NEVER changes `status` from `pending_approval`.
    await reqRef.set({ email_delivery_status: mail.status }, { merge: true });
    await audit(d, user.uid, "protected_action.requested", reqRef.id, {
      event_type: input.event_type,
      email_status: mail.status,
    });

    return { allowed: false, status: "pending_approval", request_id: reqRef.id };
  }

  // Notification-only event with anti-spam cooldown deduplication.
  const cooldownMs = Math.max(1, rule.cooldown_minutes) * 60_000;
  const recentSnap = await d.collection(PROTECTED_ACTIONS).where("user_id", "==", user.uid).get();
  const recentlySent = recentSnap.docs.some((doc) => {
    const data = doc.data();
    return (
      data.event_type === input.event_type &&
      data.status === "notified" &&
      Date.now() - millis(data.created_at) < cooldownMs
    );
  });

  const recordRef = d.collection(PROTECTED_ACTIONS).doc();
  await recordRef.set({
    user_id: user.uid,
    parent_uid: primaryParent.parent_uid,
    parent_email_masked: maskEmail(primaryParent.parent_email),
    event_type: input.event_type,
    action_type: input.action_type,
    target_id: input.target_id,
    summary: input.summary.slice(0, 400),
    payload: {},
    status: recentlySent ? "cooldown_suppressed" : "notified",
    execution_status: "recorded",
    email_delivery_status: recentlySent ? "cooldown_suppressed" : "pending",
    created_at: nowTs(),
  });

  if (recentlySent) {
    return { allowed: true, status: "cooldown_suppressed", request_id: recordRef.id };
  }

  await inAppNotify(d, primaryParent.parent_uid, {
    title: `Parent alert: ${input.event_type.replace(/_/g, " ")}`,
    body: input.summary,
    link: "/family",
  });

  const mail = await sendParentNotificationEmail({
    db: d,
    userId: user.uid,
    parentEmail: primaryParent.parent_email,
    eventId: recordRef.id,
    title: input.event_type.replace(/_/g, " "),
    detail: input.summary,
  });
  await recordRef.set({ email_delivery_status: mail.status }, { merge: true });
  await audit(d, user.uid, "protected_action.notified", recordRef.id, {
    event_type: input.event_type,
    email_status: mail.status,
  });

  return { allowed: true, status: "notified", request_id: recordRef.id };
}

/**
 * Only the verified `parent_uid` on the request may approve or deny a held
 * protected action. On approval, executes the held state change and records
 * the exact outcome.
 */
export async function decideProtectedAction(
  d: Db,
  parentActor: SessionUser,
  input: { request_id: string; approve: boolean; reason?: string },
): Promise<{
  request_id: string;
  status: "approved" | "denied";
  execution_status: "executed" | "not_executed";
}> {
  if (parentActor.deviceId) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
  const ref = d.collection(PROTECTED_ACTIONS).doc(input.request_id);

  let reqData: Record<string, unknown> = {};
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
    const data = snap.data()!;
    if (data.parent_uid !== parentActor.uid) throw new RpcError("PERMISSION_DENIED", 403);
    if (data.status !== "pending_approval") throw new RpcError("ACTION_ALREADY_DECIDED", 409);
    if (millis(data.expires_at) <= Date.now()) {
      tx.set(ref, { status: "expired", execution_status: "not_executed" }, { merge: true });
      throw new RpcError("ACTION_EXPIRED", 410);
    }
    reqData = data;
    tx.set(
      ref,
      {
        status: input.approve ? "approved" : "denied",
        execution_status: input.approve ? "pending_execution" : "not_executed",
        decided_by: parentActor.uid,
        decided_at: nowTs(),
        decision_reason: (input.reason ?? "").trim().slice(0, 240),
      },
      { merge: true },
    );
  });

  if (!input.approve) {
    await audit(d, parentActor.uid, "protected_action.denied", input.request_id, {
      action_type: reqData.action_type,
      child_uid: reqData.user_id,
    });
    await inAppNotify(d, String(reqData.user_id ?? ""), {
      title: "Parent declined protected action",
      body: `Your request (${String(reqData.summary ?? "")}) was declined by your parent.`,
      link: "/family",
    });
    return { request_id: input.request_id, status: "denied", execution_status: "not_executed" };
  }

  // Execute the held protected action server-side.
  const childUid = String(reqData.user_id ?? "");
  const actionType = String(reqData.action_type ?? "");
  const targetId = String(reqData.target_id ?? "");
  const payload = (reqData.payload ?? {}) as Record<string, unknown>;

  if (actionType === "update_parent_policy" && payload.rules) {
    const nextRules = sanitizePolicyRules(payload.rules);
    await d.collection(PARENT_POLICIES).doc(childUid).set(
      { user_id: childUid, rules: nextRules, updated_by: parentActor.uid, updated_at: nowTs() },
      { merge: true },
    );
  } else if (actionType === "revoke_device" && targetId) {
    await d.collection("devices").doc(targetId).set({ revoked_at: nowTs(), access_token_hash: null }, { merge: true });
  } else if (actionType === "dismiss_protected_notification" && targetId) {
    await d.collection("synced_notifications").doc(targetId).set(
      { dismissed_at: nowTs(), dismissed_by_device_id: "parent_approved" },
      { merge: true },
    );
  }

  await ref.set({ execution_status: "executed", executed_at: nowTs() }, { merge: true });
  await audit(d, parentActor.uid, "protected_action.approved", input.request_id, {
    action_type: actionType,
    target_id: targetId,
    child_uid: childUid,
  });
  await inAppNotify(d, childUid, {
    title: "Parent approved request",
    body: `Approved: ${String(reqData.summary ?? actionType)}`,
    link: "/family",
  });

  return { request_id: input.request_id, status: "approved", execution_status: "executed" };
}

export async function listParentDashboard(d: Db, user: SessionUser) {
  const [childSnap, parentSnap, policy, actionsChildSnap, actionsParentSnap] = await Promise.all([
    d.collection(PARENT_LINKS).where("child_uid", "==", user.uid).get(),
    d.collection(PARENT_LINKS).where("parent_uid", "==", user.uid).get(),
    getParentPolicy(d, user.uid),
    d.collection(PROTECTED_ACTIONS).where("user_id", "==", user.uid).get(),
    d.collection(PROTECTED_ACTIONS).where("parent_uid", "==", user.uid).get(),
  ]);

  const mapLink = (doc: FirebaseFirestore.QueryDocumentSnapshot | { id: string; data: () => Record<string, unknown> }) => {
    const data = doc.data();
    return {
      link_id: doc.id,
      child_uid: String(data.child_uid ?? ""),
      child_email_masked: String(data.child_email_masked ?? ""),
      parent_uid: typeof data.parent_uid === "string" ? data.parent_uid : null,
      parent_email_masked: String(data.parent_email_masked ?? ""),
      relationship_label: String(data.relationship_label ?? "Parent / Guardian"),
      status: String(data.status ?? "pending_verification"),
      verified_at: iso(data.verified_at),
      created_at: iso(data.created_at),
    };
  };

  const mapAction = (doc: { id: string; data: () => Record<string, unknown> }) => {
    const data = doc.data();
    return {
      request_id: doc.id,
      user_id: String(data.user_id ?? ""),
      parent_uid: String(data.parent_uid ?? ""),
      event_type: String(data.event_type ?? ""),
      action_type: String(data.action_type ?? ""),
      target_id: String(data.target_id ?? ""),
      summary: String(data.summary ?? ""),
      status: String(data.status ?? ""),
      execution_status: String(data.execution_status ?? ""),
      email_delivery_status: String(data.email_delivery_status ?? ""),
      created_at: iso(data.created_at),
      decided_at: iso(data.decided_at),
    };
  };

  const seenActions = new Map<string, ReturnType<typeof mapAction>>();
  for (const doc of [...actionsChildSnap.docs, ...actionsParentSnap.docs]) {
    seenActions.set(doc.id, mapAction(doc));
  }

  return {
    my_parent_links: childSnap.docs.filter((doc) => !doc.data().revoked_at).map(mapLink),
    children_i_supervise: parentSnap.docs.filter((doc) => !doc.data().revoked_at).map(mapLink),
    policy,
    actions: [...seenActions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 40),
    env_parent_email_configured: Boolean(configuredParentNotificationEmail()),
  };
}

export async function revokeParentLink(d: Db, actor: SessionUser, linkId: string) {
  if (actor.deviceId) throw new RpcError("DEVICE_SCOPE_DENIED", 403);
  const ref = d.collection(PARENT_LINKS).doc(linkId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  if (data.child_uid !== actor.uid && data.parent_uid !== actor.uid) throw new RpcError("PERMISSION_DENIED", 403);

  // If the child is revoking an already-verified parent link while `policy_disabled`
  // requires parent approval, hold it instead of silently bypassing supervision.
  if (data.status === "verified" && data.child_uid === actor.uid) {
    const policy = await getParentPolicy(d, actor.uid);
    if (policy.rules.policy_disabled.enabled && policy.rules.policy_disabled.require_parent_approval) {
      const outcome = await evaluateAndHandleProtectedEvent(d, actor, {
        event_type: "policy_disabled",
        action_type: "revoke_parent_link",
        target_id: linkId,
        summary: "Child requested removing verified parent guardian link.",
      });
      if (outcome.status === "pending_approval") {
        return { status: "pending_approval", request_id: outcome.request_id };
      }
    }
  }

  await ref.set({ status: "revoked", revoked_at: nowTs(), revoked_by: actor.uid }, { merge: true });
  await audit(d, actor.uid, "parent_link.revoked", linkId, {});
  return { status: "revoked" };
}
