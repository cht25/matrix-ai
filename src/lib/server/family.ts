// =============================================================================
// MATRIX AI — Family backend (server-only).
//
// All mutations run here through /api/rpc; Firestore rules deny every browser
// write. Every privileged check (membership, parent role, child protection,
// mirror consent) is enforced in code, not in the UI.
//
// Model:
//   families/{id}                    name, created_by, created_at
//   family_members/{uid}_{familyId}  role, is_primary, features[], revoked_at
//   family_invitations/{id}          sha256(token), status, expires_at, resend_count
//   family_devices/{id}              a child device linked through the family
//   family_activity/{id}             usage / app / browser snapshots reported
//                                    by the companion app (opt-in, on-device)
//   family_mirror_requests/{id}      consent + live session ledger
//
// Nothing in this module ever reads a child's MATRIX content for a parent
// unless the membership explicitly carries that feature AND the child device
// reported it. There is no hidden channel.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { Timestamp } from "firebase-admin/firestore";
import {
  familyInvitationUrl,
  familyPairingUrl,
  sendFamilyInvitation,
  sendFamilyNotice,
} from "@/lib/server/family-email";
import { adminDb, nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { env } from "@/lib/env";
import { RpcError } from "@/lib/server/rpc";
import { deviceCredentialHash, DEVICE_CREDENTIAL_TTL_MS, DEVICE_TOKEN_PREFIX } from "@/lib/firebase/device-session";
import { downloadImage, uploadPrivateImageBuffer } from "@/lib/server/cloudinary";
import { validateImageUpload } from "@/lib/ai/upload-validation";
import { isCloudinaryConfigured } from "@/lib/env";
import {
  CHILD_DEVICE_FEATURES,
  DEVICE_LIVE_WINDOW_MS,
  FAMILY_PAIRING_TTL_MS,
  INVITATION_TTL_MS,
  MIRROR_SESSION_TTL_MS,
  canChangeRole,
  isChildDeviceFeature,
  isFamilyRole,
  membershipDocId,
  mirrorAllowed,
  type ChildDeviceFeature,
  type FamilyInvitationSummary,
  type FamilyMemberSummary,
  type FamilyOverview,
  type FamilyActivitySnapshot,
  type FamilyListRow,
  type FamilyRole,
  type MirrorState,
} from "@/lib/family";

export { RpcError };

const FAMILIES = "families";
const MEMBERS = "family_members";
const INVITATIONS = "family_invitations";
const FAMILY_DEVICES = "family_devices";
const ACTIVITY = "family_activity";
const MIRROR = "family_mirror_requests";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function iso(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const ts = value as { toDate?: () => Date };
  return typeof ts.toDate === "function" ? ts.toDate().toISOString() : "";
}

function millis(value: unknown): number {
  const ts = value as { toMillis?: () => number };
  return typeof ts.toMillis === "function" ? ts.toMillis() : 0;
}

type Membership = {
  id: string;
  user_id: string;
  family_id: string;
  role: FamilyRole;
  is_primary?: boolean;
  features?: ChildDeviceFeature[];
  mirror_state?: MirrorState;
  device_locked?: boolean;
  device_lock_reason?: string;
};

function toMembership(id: string, data: Record<string, unknown> | undefined): Membership | null {
  if (!data) return null;
  const role: FamilyRole = data.role === "parent" ? "parent" : "child";
  const features = Array.isArray(data.features) ? data.features.filter(isChildDeviceFeature) : [];
  const mirror: MirrorState = data.mirror_state === "granted" || data.mirror_state === "revoked_by_child" || data.mirror_state === "denied_by_parent" || data.mirror_state === "expired"
    ? data.mirror_state
    : "never";
  return {
    id,
    user_id: String(data.user_id ?? ""),
    family_id: String(data.family_id ?? ""),
    role,
    is_primary: data.is_primary === true,
    features,
    mirror_state: mirror,
    device_locked: data.device_locked === true,
    device_lock_reason: typeof data.device_lock_reason === "string" ? data.device_lock_reason : "",
  };
}

async function getActiveMembership(d: Db, uid: string, familyId: string): Promise<Membership | null> {
  const snap = await d.collection(MEMBERS).doc(membershipDocId(uid, familyId)).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (data.revoked_at) return null;
  return toMembership(snap.id, data);
}

async function requireMember(d: Db, uid: string, familyId: string): Promise<Membership> {
  const membership = await getActiveMembership(d, uid, familyId);
  if (!membership) throw new RpcError("NOT_A_MEMBER", 403);
  return membership;
}

async function requireParent(d: Db, uid: string, familyId: string): Promise<Membership> {
  const membership = await requireMember(d, uid, familyId);
  if (membership.role !== "parent") throw new RpcError("PERMISSION_DENIED", 403);
  return membership;
}

async function requirePrimaryParent(d: Db, uid: string, familyId: string): Promise<Membership> {
  const membership = await requireParent(d, uid, familyId);
  if (!membership.is_primary) throw new RpcError("PRIMARY_PARENT_REQUIRED", 403);
  return membership;
}

async function audit(d: Db, actor: string, action: string, targetId: string, metadata: Record<string, unknown>) {
  await d.collection("audit_logs").add({
    actor_id: actor,
    action,
    target_type: "family",
    target_id: targetId,
    reason: "",
    metadata,
    created_at: nowTs(),
  });
}

async function notify(d: Db, uid: string, input: { type: string; title: string; body: string; link: string }) {
  await d.collection("notifications").add({
    user_id: uid,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
    read_at: null,
    delivery_channel: "in_app",
    created_at: nowTs(),
  });
}

async function profileOf(d: Db, uid: string): Promise<{ display_name: string; email: string; avatar_url: string; country: string }> {
  try {
    const snap = await d.collection("profiles").doc(uid).get();
    const data = snap.exists ? snap.data()! : {};
    return {
      display_name: String(data.full_name ?? ""),
      email: String(data.email ?? ""),
      avatar_url: typeof data.avatar_url === "string" ? data.avatar_url : "",
      country: String(data.country ?? ""),
    };
  } catch {
    return { display_name: "", email: "", avatar_url: "", country: "" };
  }
}

async function devicesOf(d: Db, uid: string) {
  try {
    const snap = await d.collection(FAMILY_DEVICES).where("user_id", "==", uid).get();
    // Legacy account-paired devices are folded in so the family view never
    // hides a device the person actually linked.
    const legacy = await d.collection("devices").where("user_id", "==", uid).get();
    const rows = [
      ...snap.docs.map((doc) => ({ id: doc.id, data: doc.data(), linked: true })),
      ...legacy.docs.map((doc) => ({ id: doc.id, data: doc.data(), linked: false })),
    ];
    const now = Date.now();
    return rows
      .filter((row) => !row.data.revoked_at)
      .map((row) => ({
        id: row.id,
        device_name: String(row.data.device_name ?? "Device"),
        platform: String(row.data.platform ?? "web"),
        device_type: String(row.data.device_type ?? "browser"),
        last_seen_at: iso(row.data.last_seen_at),
        live: millis(row.data.last_seen_at) > now - DEVICE_LIVE_WINDOW_MS,
        mirror_state: (row.data.mirror_state ?? "never") as MirrorState,
        family_linked: row.linked,
      }))
      .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

export async function createFamily(d: Db, user: SessionUser, input: { name: string }) {
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) throw new RpcError("NAME_INVALID");
  const familyRef = d.collection(FAMILIES).doc();
  const now = nowTs();
  await familyRef.set({ name, created_by: user.uid, created_at: now, updated_at: now });
  // The creator is the PRIMARY parent: the only role that can promote or
  // demote other parents, so a family can never end up with no administrator.
  await d.collection(MEMBERS).doc(membershipDocId(user.uid, familyRef.id)).set({
    user_id: user.uid,
    family_id: familyRef.id,
    role: "parent",
    is_primary: true,
    features: [...CHILD_DEVICE_FEATURES],
    mirror_state: "never",
    joined_at: now,
    updated_at: now,
    revoked_at: null,
  });
  await audit(d, user.uid, "family.create", familyRef.id, { name });
  return { family_id: familyRef.id, name, role: "parent" as const, is_primary: true };
}

export async function renameFamily(d: Db, user: SessionUser, input: { family_id: string; name: string }) {
  await requireParent(d, user.uid, input.family_id);
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) throw new RpcError("NAME_INVALID");
  await d.collection(FAMILIES).doc(input.family_id).set({ name, updated_at: nowTs() }, { merge: true });
  await audit(d, user.uid, "family.rename", input.family_id, { name });
  return { family_id: input.family_id, name };
}

/**
 * Full, human-readable family overview: real names, avatars, emails, devices
 * and per-member supervision state. This is what the family page renders —
 * previously it only had opaque member IDs.
 */
export async function familyOverview(d: Db, user: SessionUser, familyId: string): Promise<FamilyOverview> {
  const me = await requireMember(d, user.uid, familyId);
  const [familySnap, memberSnap, inviteSnap] = await Promise.all([
    d.collection(FAMILIES).doc(familyId).get(),
    d.collection(MEMBERS).where("family_id", "==", familyId).get(),
    d.collection(INVITATIONS).where("family_id", "==", familyId).get(),
  ]);
  if (!familySnap.exists) throw new RpcError("FAMILY_NOT_FOUND", 404);

  const active = memberSnap.docs
    .map((doc) => ({ doc, data: doc.data() }))
    .filter((row) => !row.data.revoked_at)
    .sort((a, b) => {
      const rank = (role: unknown) => (role === "parent" ? 0 : 1);
      return rank(a.data.role) - rank(b.data.role)
        || Number(b.data.is_primary === true) - Number(a.data.is_primary === true)
        || iso(a.data.joined_at).localeCompare(iso(b.data.joined_at));
    });

  const members: FamilyMemberSummary[] = [];
  for (const row of active) {
    const uid = String(row.data.user_id ?? "");
    const isMe = uid === user.uid;
    const membership = toMembership(row.doc.id, row.data)!;
    const isChild = membership.role === "child";
    const canSeeActivity = isMe || me.role === "parent";
    const [profile, devices, rawActivity] = await Promise.all([
      profileOf(d, uid),
      devicesOf(d, uid),
      canSeeActivity ? latestActivity(d, uid) : Promise.resolve(null),
    ]);
    const feats = membership.features ?? [];
    const activity = rawActivity
      ? isMe || !isChild
        ? rawActivity
        : {
            ...rawActivity,
            screen_time_minutes: feats.includes("screen_time") ? rawActivity.screen_time_minutes : 0,
            apps: feats.includes("app_usage_view") ? rawActivity.apps : [],
            hidden_apps: feats.includes("hidden_apps_view") ? rawActivity.hidden_apps : [],
            browser_history: feats.includes("browser_history_view") ? rawActivity.browser_history : [],
          }
      : null;
    members.push({
      member_id: row.doc.id,
      user_id: uid,
      role: membership.role,
      is_primary: membership.is_primary === true,
      is_me: isMe,
      invited_by: typeof row.data.invited_by === "string" ? row.data.invited_by : null,
      joined_at: iso(row.data.joined_at),
      display_name: profile.display_name,
      email: profile.email,
      avatar_url: profile.avatar_url,
      country: profile.country,
      devices,
      features: isChild ? feats : [],
      mirror_state: isChild ? membership.mirror_state ?? "never" : "never",
      device_locked: isChild ? membership.device_locked === true : false,
      device_lock_reason: isChild ? membership.device_lock_reason ?? "" : "",
      activity,
    });
  }

  const invitations: FamilyInvitationSummary[] = inviteSnap.docs
    .map((doc) => {
      const data = doc.data();
      const expires = millis(data.expires_at);
      const expired = data.status === "pending" && expires > 0 && Date.now() > expires;
      return {
        invitation_id: doc.id,
        invitee_email: String(data.invitee_email ?? ""),
        status: (expired ? "expired" : data.status ?? "pending") as FamilyInvitationSummary["status"],
        expires_at: iso(data.expires_at),
        created_at: iso(data.created_at),
        resend_count: Number(data.resend_count ?? 0),
        last_sent_at: iso(data.last_sent_at) || iso(data.created_at),
        email_status: String(data.email_status ?? "unknown"),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    family: { family_id: familyId, name: String(familySnap.data()?.name ?? ""), created_at: iso(familySnap.data()?.created_at) },
    me: {
      member_id: me.id,
      role: me.role,
      is_primary: me.is_primary === true,
      features: me.features ?? [],
      mirror_state: me.mirror_state ?? "never",
      device_locked: me.device_locked === true,
      device_lock_reason: me.device_lock_reason ?? "",
    },
    members,
    invitations,
    member_count: members.length,
    parent_count: members.filter((member) => member.role === "parent").length,
  };
}

// ---------------------------------------------------------------------------
// Invitations — create, resend (rotate token), revoke, review, accept
// ---------------------------------------------------------------------------

async function assertNotAlreadyMember(d: Db, familyId: string, email: string) {
  const snap = await d.collection(MEMBERS).where("family_id", "==", familyId).get();
  for (const doc of snap.docs) {
    if (doc.data().revoked_at) continue;
    const profile = await profileOf(d, String(doc.data().user_id ?? ""));
    if (profile.email.toLowerCase() === email) throw new RpcError("ALREADY_MEMBER", 409);
  }
}

export async function inviteMember(
  d: Db,
  user: SessionUser,
  input: { family_id: string; invitee_email: string; role?: string },
) {
  await requireParent(d, user.uid, input.family_id);
  const email = input.invitee_email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new RpcError("EMAIL_INVALID");
  await assertNotAlreadyMember(d, input.family_id, email);

  const token = crypto.randomBytes(24).toString("base64url");
  const ref = d.collection(INVITATIONS).doc();
  const now = nowTs();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
  await ref.set({
    family_id: input.family_id,
    invited_by: user.uid,
    invitee_email: email,
    token_hash: hashToken(token),
    status: "pending",
    expires_at: Timestamp.fromDate(new Date(expiresAt)),
    created_at: now,
    last_sent_at: now,
    resend_count: 0,
    resolved_at: null,
  });
  await audit(d, user.uid, "family.invite", ref.id, { family_id: input.family_id, invitee_email: email });

  const familySnap = await d.collection(FAMILIES).doc(input.family_id).get();
  const inviter = await profileOf(d, user.uid);
  const delivery = await sendFamilyInvitation({
    id: ref.id,
    email,
    token,
    expiresAt,
    familyName: String(familySnap.data()?.name ?? ""),
    inviterName: inviter.display_name || user.email || "",
  });
  await ref.set({ email_status: delivery.status, email_provider_id: delivery.provider_id ?? null }, { merge: true });

  return {
    invitation_id: ref.id,
    token,
    invite_url: familyInvitationUrl(token),
    expires_at: expiresAt,
    email_status: delivery.status,
    email_reason: delivery.reason ?? "",
    qr_data_url: await QRCode.toDataURL(familyInvitationUrl(token), { width: 320, margin: 2 }),
  };
}

/**
 * Resend an invitation. A resend ROTATES the bearer token, so a link that was
 * forwarded to the wrong person stops working — the point of a resend is a
 * fresh, single-use link. The old token becomes invalid immediately.
 */
export async function resendInvitation(d: Db, user: SessionUser, invitationId: string) {
  const ref = d.collection(INVITATIONS).doc(invitationId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  const familyId = String(data.family_id ?? "");
  await requireParent(d, user.uid, familyId);

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
  const resendCount = Number(data.resend_count ?? 0) + 1;
  if (resendCount > 20) throw new RpcError("INVITATION_RESEND_LIMIT", 429);

  await ref.set(
    {
      token_hash: hashToken(token),
      status: "pending",
      expires_at: Timestamp.fromDate(new Date(expiresAt)),
      last_sent_at: nowTs(),
      resend_count: resendCount,
      resolved_at: null,
    },
    { merge: true },
  );

  const familySnap = await d.collection(FAMILIES).doc(familyId).get();
  const inviter = await profileOf(d, user.uid);
  const delivery = await sendFamilyInvitation({
    id: invitationId,
    email: String(data.invitee_email ?? ""),
    token,
    expiresAt,
    familyName: String(familySnap.data()?.name ?? ""),
    inviterName: inviter.display_name || user.email || "",
    resent: true,
  });
  await ref.set({ email_status: delivery.status, email_provider_id: delivery.provider_id ?? null }, { merge: true });
  await audit(d, user.uid, "family.invitation_resend", invitationId, { resend_count: resendCount });

  return {
    invitation_id: invitationId,
    token,
    invite_url: familyInvitationUrl(token),
    expires_at: expiresAt,
    email_status: delivery.status,
    email_reason: delivery.reason ?? "",
    resend_count: resendCount,
    qr_data_url: await QRCode.toDataURL(familyInvitationUrl(token), { width: 320, margin: 2 }),
  };
}

/** Only the intended verified recipient can review a bearer invitation. */
export async function reviewInvitation(d: Db, user: SessionUser, token: string) {
  const snap = await d.collection(INVITATIONS).where("token_hash", "==", hashToken(token)).limit(1).get();
  if (snap.empty) throw new RpcError("INVITATION_INVALID", 404);
  const invite = snap.docs[0].data();
  if (invite.status !== "pending") throw new RpcError("INVITATION_INVALID", 409);
  if (Date.now() >= millis(invite.expires_at)) throw new RpcError("INVITATION_EXPIRED", 410);
  if (!user.emailVerified || user.email?.trim().toLowerCase() !== invite.invitee_email) throw new RpcError("INVITATION_EMAIL_MISMATCH", 403);
  const family = await d.collection(FAMILIES).doc(String(invite.family_id)).get();
  if (!family.exists) throw new RpcError("INVITATION_INVALID", 404);
  const inviter = await profileOf(d, String(invite.invited_by ?? ""));
  return {
    family_id: String(invite.family_id),
    name: String(family.data()?.name ?? "Family"),
    role: "child" as const,
    invited_by_name: inviter.display_name || inviter.email,
    expires_at: iso(invite.expires_at),
  };
}

export async function acceptInvitation(d: Db, user: SessionUser, input: { token: string }) {
  const snap = await d.collection(INVITATIONS).where("token_hash", "==", hashToken(input.token)).limit(1).get();
  if (snap.empty) throw new RpcError("INVITATION_INVALID", 404);
  const invitationRef = d.collection(INVITATIONS).doc(snap.docs[0].id);
  let invitedBy = "";
  // Re-read and consume atomically: concurrent accepts must not reuse a token.
  const familyId = await d.runTransaction(async (tx) => {
    const invite = await tx.get(invitationRef);
    const data = invite.data();
    if (!data || data.status !== "pending") throw new RpcError("INVITATION_INVALID", 409);
    if (Date.now() >= millis(data.expires_at)) throw new RpcError("INVITATION_EXPIRED", 410);
    if (!user.emailVerified || user.email?.trim().toLowerCase() !== data.invitee_email) {
      throw new RpcError("INVITATION_EMAIL_MISMATCH", 403);
    }
    const id = String(data.family_id);
    const memberRef = d.collection(MEMBERS).doc(membershipDocId(user.uid, id));
    const parentRef = d.collection(MEMBERS).doc(membershipDocId(String(data.invited_by), id));
    const [member, parent] = await Promise.all([tx.get(memberRef), tx.get(parentRef)]);
    if (!parent.exists || parent.data()?.revoked_at || parent.data()?.role !== "parent") throw new RpcError("INVITATION_INVALID", 403);
    if (member.exists && !member.data()?.revoked_at) throw new RpcError("ALREADY_MEMBER", 409);
    const now = nowTs();
    tx.set(memberRef, {
      user_id: user.uid,
      family_id: id,
      role: "child",
      is_primary: false,
      // Supervision is opt-in per feature: joining the family grants nothing.
      features: [],
      mirror_state: "never",
      invited_by: data.invited_by,
      joined_at: now,
      updated_at: now,
      revoked_at: null,
    });
    invitedBy = String(data.invited_by ?? "");
    tx.set(invitationRef, { status: "accepted", resolved_at: now }, { merge: true });
    return id;
  });
  await audit(d, user.uid, "family.join", familyId, { invitation_id: invitationRef.id });
  // Tell the inviting parent that the join actually happened.
  const joined = await profileOf(d, user.uid);
  if (invitedBy) await notify(d, invitedBy, {
    type: "family",
    title: "Family invitation accepted",
    body: `${joined.display_name || user.email || "A new member"} joined your family. Nothing is monitored until you enable a feature.`,
    link: "/family",
  });
  return { family_id: familyId, role: "child" as const };
}

export async function revokeInvitation(d: Db, user: SessionUser, invitationId: string) {
  const ref = d.collection(INVITATIONS).doc(invitationId);
  await d.runTransaction(async (tx) => {
    const invite = await tx.get(ref);
    if (!invite.exists) throw new RpcError("NOT_FOUND", 404);
    const data = invite.data()!;
    const parent = await tx.get(d.collection(MEMBERS).doc(membershipDocId(user.uid, String(data.family_id))));
    if (!parent.exists || parent.data()?.revoked_at || parent.data()?.role !== "parent") throw new RpcError("PERMISSION_DENIED", 403);
    if (data.status !== "pending") throw new RpcError("INVITATION_INVALID", 409);
    tx.set(ref, { status: "revoked", resolved_at: nowTs() }, { merge: true });
  });
  await audit(d, user.uid, "family.invitation_revoke", invitationId, {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Members — profile, role, features, removal
// ---------------------------------------------------------------------------

export async function memberDetail(d: Db, user: SessionUser, input: { family_id: string; member_id: string }) {
  const me = await requireMember(d, user.uid, input.family_id);
  const snap = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!snap.exists || snap.data()?.family_id !== input.family_id) throw new RpcError("NOT_A_MEMBER", 404);
  const membership = toMembership(snap.id, snap.data())!;
  const self = membership.user_id === user.uid;
  // A child may only inspect their own membership. A parent sees everyone.
  if (!self && me.role !== "parent") throw new RpcError("PERMISSION_DENIED", 403);
  const profile = await profileOf(d, membership.user_id);
  const devices = await devicesOf(d, membership.user_id);
  const rawActivity = self || me.role === "parent"
    ? await latestActivity(d, membership.user_id)
    : null;
  const feats = membership.features ?? [];
  const activity = rawActivity
    ? self || membership.role !== "child"
      ? rawActivity
      : {
          ...rawActivity,
          screen_time_minutes: feats.includes("screen_time") ? rawActivity.screen_time_minutes : 0,
          apps: feats.includes("app_usage_view") ? rawActivity.apps : [],
          hidden_apps: feats.includes("hidden_apps_view") ? rawActivity.hidden_apps : [],
          browser_history: feats.includes("browser_history_view") ? rawActivity.browser_history : [],
        }
    : null;
  return {
    member_id: snap.id,
    user_id: membership.user_id,
    role: membership.role,
    is_primary: membership.is_primary === true,
    is_me: self,
    display_name: profile.display_name,
    email: profile.email,
    avatar_url: profile.avatar_url,
    country: profile.country,
    joined_at: iso(snap.data()?.joined_at),
    features: membership.features ?? [],
    mirror_state: membership.mirror_state ?? "never",
    device_locked: membership.role === "child" ? membership.device_locked === true : false,
    device_lock_reason: membership.role === "child" ? membership.device_lock_reason ?? "" : "",
    devices,
    activity,
  };
}

/** Latest opted-in usage / app / browser snapshot reported by the device. */
async function latestActivity(d: Db, uid: string): Promise<FamilyActivitySnapshot | null> {
  try {
    const snap = await d.collection(ACTIVITY).where("user_id", "==", uid).get();
    const rows = snap.docs
      .map((doc) => ({ id: doc.id, data: doc.data() }))
      .sort((a, b) => millis(b.data.reported_at) - millis(a.data.reported_at));
    if (!rows.length) return null;
    const latest = rows[0];
    return {
      reported_at: iso(latest.data.reported_at),
      device_id: String(latest.data.device_id ?? ""),
      screen_time_minutes: Number(latest.data.screen_time_minutes ?? 0),
      apps: Array.isArray(latest.data.apps) ? latest.data.apps.slice(0, 60) : [],
      browser_history: Array.isArray(latest.data.browser_history) ? latest.data.browser_history.slice(0, 60) : [],
      hidden_apps: Array.isArray(latest.data.hidden_apps) ? latest.data.hidden_apps.slice(0, 40) : [],
    };
  } catch {
    return null;
  }
}

export async function changeMemberRole(
  d: Db,
  user: SessionUser,
  input: { family_id: string; member_id: string; role: string },
) {
  const actor = await requireParent(d, user.uid, input.family_id);
  if (!isFamilyRole(input.role)) throw new RpcError("ROLE_INVALID");
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id) throw new RpcError("NOT_A_MEMBER", 404);
  if (target.data()?.revoked_at) throw new RpcError("NOT_A_MEMBER", 404);

  const members = await d.collection(MEMBERS).where("family_id", "==", input.family_id).get();
  const parentCount = members.docs.filter((doc) => !doc.data().revoked_at && doc.data().role === "parent").length;
  const allowed = canChangeRole({
    actor: { role: actor.role, isPrimary: actor.is_primary === true },
    targetRole: (target.data()?.role === "parent" ? "parent" : "child"),
    targetIsPrimary: target.data()?.is_primary === true,
    nextRole: input.role,
    activeParentCount: parentCount,
  });
  if (!allowed) {
    throw new RpcError(target.data()?.role === "parent" && target.data()?.is_primary ? "PRIMARY_PARENT_IMMUTABLE" : "PERMISSION_DENIED", 403);
  }

  await target.ref.set(
    {
      role: input.role,
      // Promoting to parent makes the member a full co-parent; demoting back to
      // child is only done by the primary parent and clears supervision flags.
      ...(input.role === "parent" ? { is_primary: false, features: [...CHILD_DEVICE_FEATURES] } : { features: [] }),
      updated_at: nowTs(),
    },
    { merge: true },
  );
  await audit(d, user.uid, "family.role_change", input.member_id, { family_id: input.family_id, role: input.role });
  await notify(d, String(target.data()?.user_id ?? ""), {
    type: "family",
    title: input.role === "parent" ? "You are now a parent in this family" : "Your family role changed",
    body: input.role === "parent"
      ? "You can now invite members, manage device supervision and grant screen-mirroring access."
      : "Your role in the family was changed to member.",
    link: "/family",
  });
  return { member_id: input.member_id, role: input.role };
}

/** Update the supervision features enabled for one child membership. */
export async function updateMemberFeatures(
  d: Db,
  user: SessionUser,
  input: { family_id: string; member_id: string; features: string[] },
) {
  await requireParent(d, user.uid, input.family_id);
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id || target.data()?.revoked_at) throw new RpcError("NOT_A_MEMBER", 404);
  if (target.data()?.role !== "child") throw new RpcError("FEATURES_PARENT_ONLY_SELF", 400);
  const requested: ChildDeviceFeature[] = input.features.filter(isChildDeviceFeature);
  if (requested.length !== input.features.length) throw new RpcError("FEATURE_INVALID", 400);

  const previous: ChildDeviceFeature[] = Array.isArray(target.data()?.features) ? (target.data()!.features as unknown[]).filter(isChildDeviceFeature) : [];
  const added = requested.filter((feature) => !previous.includes(feature));
  const removed = previous.filter((feature) => !requested.includes(feature));

  // Turning mirroring off must also kill an in-flight session immediately.
  const patch: Record<string, unknown> = { features: requested, updated_at: nowTs() };
  if (removed.includes("mirror_screen")) patch.mirror_state = "denied_by_parent";
  if (added.includes("mirror_screen") && !removed.includes("mirror_screen")) patch.mirror_state = "granted";

  await target.ref.set(patch, { merge: true });
  if (removed.includes("mirror_screen")) await endMirrorSessions(d, input.family_id, String(target.data()?.user_id ?? ""), "feature_disabled");

  await audit(d, user.uid, "family.features_update", input.member_id, { added, removed });
  if (added.length || removed.length) {
    await notify(d, String(target.data()?.user_id ?? ""), {
      type: "family",
      title: "Family supervision settings changed",
      body: [
        added.length ? `Enabled: ${added.join(", ")}.` : "",
        removed.length ? `Disabled: ${removed.join(", ")}.` : "",
        "Every change is visible here and can be reviewed any time.",
      ].filter(Boolean).join(" "),
      link: "/family",
    });
  }
  return { member_id: input.member_id, features: requested };
}

export async function revokeMember(d: Db, user: SessionUser, input: { family_id: string; member_id: string }) {
  const actor = await requireMember(d, user.uid, input.family_id);
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id) throw new RpcError("NOT_A_MEMBER", 404);

  const targetUserId = String(target.data()?.user_id ?? "");
  const selfRevoke = targetUserId === user.uid;
  if (!selfRevoke) {
    if (actor.role !== "parent") throw new RpcError("PERMISSION_DENIED", 403);
    if (target.data()?.role === "parent" && !actor.is_primary) throw new RpcError("PRIMARY_PARENT_REQUIRED", 403);
    if (target.data()?.is_primary) throw new RpcError("PRIMARY_PARENT_IMMUTABLE", 403);
  }

  await target.ref.set({ revoked_at: nowTs(), features: [], mirror_state: "denied_by_parent" }, { merge: true });
  await endMirrorSessions(d, input.family_id, targetUserId, "membership_revoked");
  await audit(d, user.uid, "family.revoke", input.member_id, { family_id: input.family_id, self: selfRevoke });
  if (!selfRevoke) {
    await notify(d, targetUserId, {
      type: "family",
      title: "Removed from a family",
      body: "Your access to this MATRIX family and its supervision features ended.",
      link: "/family",
    });
  }
  return { ok: true };
}

/**
 * Hand the primary-parent flag to another active parent. This is how a family
 * survives the original creator leaving: the primary parent must transfer it
 * explicitly, and only a primary parent can do so.
 */
export async function transferPrimary(d: Db, user: SessionUser, input: { family_id: string; member_id: string }) {
  await requirePrimaryParent(d, user.uid, input.family_id);
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id || target.data()?.revoked_at) throw new RpcError("NOT_A_MEMBER", 404);
  if (target.data()?.role !== "parent") throw new RpcError("PARENT_REQUIRED", 400);
  const mine = d.collection(MEMBERS).doc(membershipDocId(user.uid, input.family_id));
  await d.runTransaction(async (tx) => {
    tx.set(target.ref, { is_primary: true, updated_at: nowTs() }, { merge: true });
    tx.set(mine, { is_primary: false, updated_at: nowTs() }, { merge: true });
  });
  await audit(d, user.uid, "family.primary_transfer", input.member_id, { family_id: input.family_id });
  await notify(d, String(target.data()?.user_id ?? ""), {
    type: "family",
    title: "You are now the primary parent",
    body: "You can grant or revoke screen-mirroring access and transfer this role again.",
    link: "/family",
  });
  return { ok: true };
}

/** Backwards-compatible member list used by older clients. */
export async function listMembers(d: Db, user: SessionUser, familyId: string) {
  await requireMember(d, user.uid, familyId);
  const snap = await d.collection(MEMBERS).where("family_id", "==", familyId).get();
  return snap.docs
    .filter((m) => !m.data().revoked_at)
    .map((m) => ({
      member_id: m.id,
      user_id: m.data().user_id,
      role: m.data().role,
      invited_by: m.data().invited_by ?? null,
      joined_at: iso(m.data().joined_at),
    }));
}

export async function listFamiliesForUser(d: Db, uid: string): Promise<FamilyListRow[]> {
  const snap = await d.collection(MEMBERS).where("user_id", "==", uid).get();
  const out: FamilyListRow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.revoked_at) continue;
    const family = await d.collection(FAMILIES).doc(String(data.family_id)).get();
    if (!family.exists) continue;
    const [members, invites] = await Promise.all([
      d.collection(MEMBERS).where("family_id", "==", data.family_id).get(),
      d.collection(INVITATIONS).where("family_id", "==", data.family_id).get(),
    ]);
    const active = members.docs.filter((m) => !m.data().revoked_at).length;
    out.push({
      family_id: String(data.family_id),
      role: data.role === "parent" ? "parent" : "child",
      name: String(family.data()?.name ?? ""),
      member_count: active,
      is_primary: data.is_primary === true,
      pending_invitations: invites.docs.filter((i) => i.data().status === "pending").length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Screen mirroring — two-key consent, always visible, revocable by the child
// ---------------------------------------------------------------------------

async function endMirrorSessions(d: Db, familyId: string, targetUid: string, reason: string) {
  try {
    const snap = await d.collection(MIRROR).where("target_uid", "==", targetUid).get();
    await Promise.all(
      snap.docs
        .filter((doc) => doc.data().family_id === familyId && doc.data().status === "active")
        .map((doc) => doc.ref.set({ status: "ended", ended_reason: reason, ended_at: nowTs() }, { merge: true })),
    );
  } catch { /* never let cleanup break the primary mutation */ }
}

/**
 * Start a mirror session. Requirements, all re-checked here:
 *  · the requester is a parent in the family;
 *  · the membership carries the `mirror_screen` feature;
 *  · the device granted consent (`mirror_state === "granted"`).
 * Starting a session notifies the device, so anyone using it sees that a parent
 * is watching. That is a product promise, not an implementation detail.
 */
export async function startMirrorSession(d: Db, user: SessionUser, input: { family_id: string; member_id: string; device_id?: string }) {
  const actor = await requireParent(d, user.uid, input.family_id);
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id || target.data()?.revoked_at) throw new RpcError("NOT_A_MEMBER", 404);
  const targetUid = String(target.data()?.user_id ?? "");
  const features = Array.isArray(target.data()?.features) ? target.data()!.features.filter(isChildDeviceFeature) : [];
  const state = (target.data()?.mirror_state ?? "never") as MirrorState;
  if (!mirrorAllowed(state, features.includes("mirror_screen"), true)) {
    throw new RpcError(state === "revoked_by_child" ? "MIRROR_REVOKED_BY_CHILD" : state === "granted" ? "MIRROR_FEATURE_DISABLED" : "MIRROR_CONSENT_REQUIRED", 403);
  }
  const sessionId = d.collection(MIRROR).doc();
  const expiresAt = Date.now() + MIRROR_SESSION_TTL_MS;
  await sessionId.set({
    family_id: input.family_id,
    member_id: input.member_id,
    target_uid: targetUid,
    viewer_uid: user.uid,
    viewer_member_id: actor.id,
    device_id: input.device_id ?? "",
    status: "active",
    started_at: nowTs(),
    expires_at: Timestamp.fromMillis(expiresAt),
    ended_at: null,
    ended_reason: null,
    frames: 0,
  });
  await audit(d, user.uid, "family.mirror_start", input.member_id, { session_id: sessionId.id });
  await notify(d, targetUid, {
    type: "family",
    title: "Screen mirroring started",
    body: "A parent is viewing this device's screen. You can stop it at any time from Family → My supervision.",
    link: "/family",
  });
  return { session_id: sessionId.id, expires_at: new Date(expiresAt).toISOString(), status: "active" as const };
}

export async function stopMirrorSession(d: Db, user: SessionUser, sessionId: string) {
  const ref = d.collection(MIRROR).doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  const targetUid = String(data.target_uid ?? "");
  if (data.family_id) await requireMember(d, user.uid, String(data.family_id));
  // Either the viewer or the person being viewed may end a session.
  if (user.uid !== targetUid && user.uid !== data.viewer_uid) throw new RpcError("PERMISSION_DENIED", 403);
  await ref.set({ status: "ended", ended_at: nowTs(), ended_reason: user.uid === targetUid ? "stopped_by_member" : "stopped_by_viewer" }, { merge: true });
  await audit(d, user.uid, "family.mirror_stop", sessionId, {});
  return { ok: true };
}

/**
 * The child's own control. Revoking consent stops every session instantly and
 * sets `revoked_by_child`: only a parent granting access again (or re-enabling
 * the feature) can restore it. A child can also re-grant it themselves.
 */
export async function setMirrorConsent(d: Db, user: SessionUser, input: { family_id: string; consent: "grant" | "revoke" }) {
  const me = await requireMember(d, user.uid, input.family_id);
  if (me.role !== "child") throw new RpcError("CONSENT_CHILD_ONLY", 403);
  const ref = d.collection(MEMBERS).doc(me.id);
  if (input.consent === "revoke") {
    await ref.set({ mirror_state: "revoked_by_child", updated_at: nowTs() }, { merge: true });
    await endMirrorSessions(d, input.family_id, user.uid, "revoked_by_child");
    await audit(d, user.uid, "family.mirror_revoke", me.id, {});
    const parents = await d.collection(MEMBERS).where("family_id", "==", input.family_id).get();
    for (const parent of parents.docs.filter((doc) => !doc.data().revoked_at && doc.data().role === "parent")) {
      await notify(d, String(parent.data().user_id ?? ""), {
        type: "family",
        title: "Screen-mirroring access revoked",
        body: "A family member turned off screen mirroring on their device. A parent must grant access again to restart it.",
        link: "/family",
      });
    }
    return { mirror_state: "revoked_by_child" as const };
  }
  // Re-granting is the member's own informed choice and is always announced.
  await ref.set({ mirror_state: "granted", updated_at: nowTs() }, { merge: true });
  await audit(d, user.uid, "family.mirror_grant", me.id, {});
  return { mirror_state: "granted" as const };
}

/**
 * Parent grants mirroring again after a child revoked it. Requires the primary
 * parent — the same person who owns the family-level trust decision.
 */
export async function grantMirrorAccess(d: Db, user: SessionUser, input: { family_id: string; member_id: string }) {
  await requirePrimaryParent(d, user.uid, input.family_id);
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id || target.data()?.revoked_at) throw new RpcError("NOT_A_MEMBER", 404);
  if (target.data()?.role !== "child") throw new RpcError("CONSENT_CHILD_ONLY", 400);
  const features = Array.isArray(target.data()?.features) ? target.data()!.features.filter(isChildDeviceFeature) : [];
  const nextFeatures = features.includes("mirror_screen") ? features : [...features, "mirror_screen"];
  await target.ref.set({ mirror_state: "granted", features: nextFeatures, updated_at: nowTs() }, { merge: true });
  await audit(d, user.uid, "family.mirror_granted_by_parent", input.member_id, {});
  await notify(d, String(target.data()?.user_id ?? ""), {
    type: "family",
    title: "A parent re-enabled screen mirroring",
    body: "Screen mirroring is available again for this family. You can revoke it at any time from Family → My supervision.",
    link: "/family",
  });
  return { mirror_state: "granted" as const };
}

export async function mirrorSessionStatus(d: Db, user: SessionUser, sessionId: string) {
  const snap = await d.collection(MIRROR).doc(sessionId).get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  if (data.family_id) await requireMember(d, user.uid, String(data.family_id));
  if (user.uid !== data.target_uid && user.uid !== data.viewer_uid) throw new RpcError("PERMISSION_DENIED", 403);
  const active = data.status === "active" && millis(data.expires_at) > Date.now();
  let frameDataUrl: string | null = null;
  const framePath = typeof data.latest_frame_path === "string" ? data.latest_frame_path : "";
  if (framePath) {
    const bytes = await downloadImage(framePath);
    if (bytes) {
      const ext = framePath.slice(framePath.lastIndexOf(".") + 1).toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      frameDataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    }
  } else if (typeof data.inline_frame_data_url === "string" && data.inline_frame_data_url.startsWith("data:image/")) {
    frameDataUrl = data.inline_frame_data_url;
  }
  return {
    session_id: sessionId,
    status: active ? "active" : "ended",
    started_at: iso(data.started_at),
    expires_at: iso(data.expires_at),
    ended_reason: data.ended_reason ?? null,
    frames: Number(data.frames ?? 0),
    latest_frame_at: iso(data.latest_frame_at),
    frame_data_url: frameDataUrl,
  };
}

/**
 * Child device uploads a live screen-mirror snapshot (ss). Stored privately on
 * Cloudinary under `mirror-frames/{uid}/...` when configured, and only accepted
 * while an active, consented mirror session exists for `user.uid`.
 */
export async function uploadMirrorFrame(
  d: Db,
  user: SessionUser,
  input: { session_id?: string; storage_path?: string; image_data_url?: string },
) {
  const nowMs = Date.now();
  let sessionDoc: { id: string; ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> } | null = null;

  if (input.session_id) {
    const snap = await d.collection(MIRROR).doc(input.session_id).get();
    if (snap.exists && snap.data()?.target_uid === user.uid && snap.data()?.status === "active" && millis(snap.data()?.expires_at) > nowMs) {
      sessionDoc = { id: snap.id, ref: snap.ref, data: snap.data()! };
    }
  } else {
    const snap = await d.collection(MIRROR).where("target_uid", "==", user.uid).get();
    const active = snap.docs.find((doc) => doc.data().status === "active" && millis(doc.data().expires_at) > nowMs);
    if (active) sessionDoc = { id: active.id, ref: active.ref, data: active.data() };
  }
  if (!sessionDoc) throw new RpcError("MIRROR_SESSION_NOT_ACTIVE", 409);

  let framePath = "";
  let inlineFallback = "";
  if (input.storage_path) {
    const trimmed = input.storage_path.trim();
    if (!trimmed.startsWith(`mirror-frames/${user.uid}/`)) throw new RpcError("STORAGE_OWNERSHIP_VIOLATION", 403);
    framePath = trimmed;
  } else if (input.image_data_url) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input.image_data_url.trim());
    if (!match) throw new RpcError("IMAGE_INVALID", 400);
    const bytes = Buffer.from(match[2], "base64");
    const check = validateImageUpload(new Uint8Array(bytes), null);
    if (!check.ok) throw new RpcError(check.error ?? "IMAGE_INVALID", 400);
    if (isCloudinaryConfigured()) {
      framePath = await uploadPrivateImageBuffer("mirror-frames", user.uid, bytes, `mirror.${check.mime === "image/png" ? "png" : check.mime === "image/webp" ? "webp" : "jpg"}`);
    } else if (input.image_data_url.length <= 450_000) {
      inlineFallback = input.image_data_url.trim();
    } else {
      throw new RpcError("UPLOADS_NOT_CONFIGURED", 503);
    }
  } else {
    throw new RpcError("IMAGE_REQUIRED", 400);
  }

  const nextFrames = Number(sessionDoc.data.frames ?? 0) + 1;
  await sessionDoc.ref.set(
    {
      frames: nextFrames,
      latest_frame_at: nowTs(),
      ...(framePath ? { latest_frame_path: framePath, inline_frame_data_url: null } : { inline_frame_data_url: inlineFallback }),
      // Extend active window by 2m while frames actively stream, up to 15m max.
      expires_at: Timestamp.fromMillis(Math.min(millis(sessionDoc.data.started_at || nowTs()) + 15 * 60_000, nowMs + MIRROR_SESSION_TTL_MS)),
    },
    { merge: true },
  );
  return { ok: true, session_id: sessionDoc.id, frames: nextFrames };
}

/**
 * Google Family Link style remote lock ("turn off / pause device"). Requires
 * the `device_lock` supervision feature to be enabled on the child membership.
 */
export async function setDeviceLock(
  d: Db,
  user: SessionUser,
  input: { family_id: string; member_id: string; locked: boolean; reason?: string },
) {
  await requireParent(d, user.uid, input.family_id);
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id || target.data()?.revoked_at) {
    throw new RpcError("NOT_A_MEMBER", 404);
  }
  if (target.data()?.role !== "child") throw new RpcError("CONSENT_CHILD_ONLY", 400);
  const features = Array.isArray(target.data()?.features) ? target.data()!.features.filter(isChildDeviceFeature) : [];
  if (input.locked && !features.includes("device_lock")) {
    throw new RpcError("DEVICE_LOCK_FEATURE_DISABLED", 403);
  }
  const reason = input.locked ? (input.reason ?? "").trim().slice(0, 140) || "Paused by a parent in your family" : "";
  await target.ref.set(
    {
      device_locked: input.locked,
      device_lock_reason: reason,
      device_locked_by: input.locked ? user.uid : null,
      updated_at: nowTs(),
    },
    { merge: true },
  );
  await audit(d, user.uid, input.locked ? "family.device_lock" : "family.device_unlock", input.member_id, { reason });
  const targetUid = String(target.data()?.user_id ?? "");
  await notify(d, targetUid, {
    type: "family",
    title: input.locked ? "Device paused by your family" : "Device unlocked by your family",
    body: input.locked
      ? `${reason}. You can request access from your parent at any time.`
      : "Your parent unlocked your device.",
    link: "/family",
  });
  return { ok: true, device_locked: input.locked, device_lock_reason: reason };
}

/**
 * A child member asks their parent(s) to unlock the device or change a
 * supervision / mirroring setting ("need to grant access from parent").
 */
export async function requestParentAccess(
  d: Db,
  user: SessionUser,
  input: { family_id: string; kind: "unlock_device" | "disable_mirror" | "adjust_supervision"; note?: string },
) {
  const me = await requireMember(d, user.uid, input.family_id);
  const meProfile = await profileOf(d, user.uid);
  const who = meProfile.display_name || meProfile.email || "A family member";
  const note = (input.note ?? "").trim().slice(0, 200);
  const label =
    input.kind === "unlock_device"
      ? `${who} asked to unlock their device`
      : input.kind === "disable_mirror"
        ? `${who} asked to change screen-mirroring access`
        : `${who} asked to review supervision settings`;

  const parents = await d.collection(MEMBERS).where("family_id", "==", input.family_id).get();
  for (const parent of parents.docs.filter((doc) => !doc.data().revoked_at && doc.data().role === "parent")) {
    await notify(d, String(parent.data().user_id ?? ""), {
      type: "family",
      title: label,
      body: note || "Open Family to review and grant or keep the current setting.",
      link: "/family",
    });
  }
  await audit(d, user.uid, "family.request_parent_access", me.id, { kind: input.kind, note });
  return { ok: true };
}

/**
 * Lightweight poll used by the persistent in-app banner, Tauri desktop app and
 * mobile companion app so ANYONE holding the device immediately sees if a
 * parent in Family is viewing the screen or if the device is paused/locked.
 */
export async function activeMirrorAndLockForUser(d: Db, user: SessionUser) {
  const nowMs = Date.now();
  const [mirrorSnap, memberSnap] = await Promise.all([
    d.collection(MIRROR).where("target_uid", "==", user.uid).get().catch(() => null),
    d.collection(MEMBERS).where("user_id", "==", user.uid).get().catch(() => null),
  ]);

  const activeSessions: Array<{
    session_id: string;
    family_id: string;
    family_name: string;
    viewer_name: string;
    started_at: string;
    expires_at: string;
    frames: number;
  }> = [];

  for (const doc of mirrorSnap?.docs ?? []) {
    const data = doc.data();
    if (data.status !== "active" || millis(data.expires_at) <= nowMs) continue;
    const famId = String(data.family_id ?? "");
    const [famDoc, viewerProfile] = await Promise.all([
      famId ? d.collection(FAMILIES).doc(famId).get().catch(() => null) : Promise.resolve(null),
      profileOf(d, String(data.viewer_uid ?? "")),
    ]);
    activeSessions.push({
      session_id: doc.id,
      family_id: famId,
      family_name: String(famDoc?.data()?.name ?? "Family"),
      viewer_name: viewerProfile.display_name || viewerProfile.email || "A parent",
      started_at: iso(data.started_at),
      expires_at: iso(data.expires_at),
      frames: Number(data.frames ?? 0),
    });
  }

  let locked: { family_id: string; family_name: string; reason: string } | null = null;
  for (const doc of memberSnap?.docs ?? []) {
    const data = doc.data();
    if (data.revoked_at || data.role !== "child" || data.device_locked !== true) continue;
    const famId = String(data.family_id ?? "");
    const famDoc = famId ? await d.collection(FAMILIES).doc(famId).get().catch(() => null) : null;
    locked = {
      family_id: famId,
      family_name: String(famDoc?.data()?.name ?? "Family"),
      reason: String(data.device_lock_reason || "Paused by a parent in your family"),
    };
    break;
  }

  return { active_sessions: activeSessions, locked };
}

// ---------------------------------------------------------------------------
// Family device linking (a DIFFERENT account is expected and supported)
// ---------------------------------------------------------------------------

export type FamilyPairingChallenge = {
  pair_token: string;
  qr_payload: string;
  qr_data_url: string;
  expires_at: string;
  member_id: string;
  member_name: string;
};

/**
 * A parent (or a member linking their own phone) creates a one-hour pairing
 * token for a family MEMBER, so the device owner can sign in with their own
 * account — a different Firebase account is the normal case, not an error.
 */
export async function createFamilyPairing(
  d: Db,
  user: SessionUser,
  input: { family_id: string; member_id?: string; device_label?: string },
): Promise<FamilyPairingChallenge> {
  const me = await requireMember(d, user.uid, input.family_id);
  const memberId = input.member_id || me.id;
  if (memberId !== me.id && me.role !== "parent") throw new RpcError("PERMISSION_DENIED", 403);
  const memberSnap = await d.collection(MEMBERS).doc(memberId).get();
  if (!memberSnap.exists || memberSnap.data()?.family_id !== input.family_id || memberSnap.data()?.revoked_at) {
    throw new RpcError("NOT_A_MEMBER", 404);
  }
  const targetUid = String(memberSnap.data()?.user_id ?? "");
  const profile = await profileOf(d, targetUid);

  const pairToken = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + FAMILY_PAIRING_TTL_MS).toISOString();
  const ref = d.collection("family_pairings").doc();
  await ref.set({
    family_id: input.family_id,
    member_id: memberId,
    target_uid: targetUid,
    created_by: user.uid,
    device_label: (input.device_label ?? "").slice(0, 80),
    token_hash: hashToken(pairToken),
    status: "pending",
    expires_at: Timestamp.fromDate(new Date(expiresAt)),
    created_at: nowTs(),
    consumed_at: null,
  });
  await audit(d, user.uid, "family.pairing_create", ref.id, { family_id: input.family_id, member_id: memberId });
  const qrPayload = `matrix-family-pair:v1.${ref.id}.${pairToken}`;
  return {
    pair_token: pairToken,
    qr_payload: qrPayload,
    qr_data_url: await QRCode.toDataURL(qrPayload, { width: 320, margin: 2 }),
    expires_at: expiresAt,
    member_id: memberId,
    member_name: profile.display_name || profile.email || "Family member",
  };
}

/**
 * Complete linking on the DEVICE's own account. The scanning account must be
 * the member the link was created for; it does not need to be the parent's
 * account. The device is then registered under the member's uid and a scoped
 * device credential is issued for the companion app.
 */
export async function completeFamilyPairing(
  d: Db,
  scanner: SessionUser,
  input: { pair_token: string; device_name: string; device_type: string; platform: string },
) {
  const token = input.pair_token.trim();
  const snap = await d.collection("family_pairings").where("token_hash", "==", hashToken(token)).limit(1).get();
  if (snap.empty) throw new RpcError("PAIRING_INVALID", 404);
  const pairingRef = d.collection("family_pairings").doc(snap.docs[0].id);
  const secret = crypto.randomBytes(32).toString("base64url");
  const credentialExpires = Date.now() + DEVICE_CREDENTIAL_TTL_MS;

  const result = await d.runTransaction(async (tx) => {
    const pairing = await tx.get(pairingRef);
    const data = pairing.data();
    if (!data || data.status !== "pending") throw new RpcError("PAIRING_USED", 409);
    if (Date.now() > millis(data.expires_at)) throw new RpcError("PAIRING_EXPIRED", 410);
    if (String(data.target_uid) !== scanner.uid) throw new RpcError("PAIRING_ACCOUNT_MISMATCH", 403);
    const memberSnap = await tx.get(d.collection(MEMBERS).doc(String(data.member_id)));
    if (!memberSnap.exists || memberSnap.data()?.revoked_at) throw new RpcError("NOT_A_MEMBER", 403);

    const deviceRef = d.collection(FAMILY_DEVICES).doc();
    const now = nowTs();
    tx.set(deviceRef, {
      user_id: scanner.uid,
      family_id: String(data.family_id),
      member_id: String(data.member_id),
      device_name: input.device_name.slice(0, 80) || "Family device",
      device_type: input.device_type.slice(0, 40),
      platform: input.platform.slice(0, 40),
      scopes: ["family:report", "family:mirror", "family:read", "chat:read", "chat:write", "notifications:read"],
      access_token_hash: deviceCredentialHash(deviceRef.id, secret),
      access_token_expires_at: Timestamp.fromMillis(credentialExpires),
      pairing_id: pairingRef.id,
      paired_by: scanner.uid,
      mirror_state: memberSnap.data()?.mirror_state ?? "never",
      paired_at: now,
      last_seen_at: now,
      revoked_at: null,
      created_at: now,
    });
    tx.set(pairingRef, { status: "consumed", consumed_at: now, device_id: deviceRef.id }, { merge: true });
    return { deviceId: deviceRef.id, familyId: String(data.family_id) };
  });

  await audit(d, scanner.uid, "family.device_link", result.deviceId, { family_id: result.familyId });
  const parents = await d.collection(MEMBERS).where("family_id", "==", result.familyId).get();
  for (const parent of parents.docs.filter((doc) => !doc.data().revoked_at && doc.data().role === "parent")) {
    await notify(d, String(parent.data().user_id ?? ""), {
      type: "family",
      title: "A family device was linked",
      body: `${input.device_name || "A device"} (${input.platform}) is now linked. Screen mirroring still requires consent.`,
      link: "/family",
    });
  }
  return {
    device_id: result.deviceId,
    family_id: result.familyId,
    access_token: `${DEVICE_TOKEN_PREFIX}${result.deviceId}.${secret}`,
    access_token_expires_at: new Date(credentialExpires).toISOString(),
  };
}

/** Companion-app telemetry: per-app usage, browser history, hidden apps. */
export async function reportFamilyActivity(
  d: Db,
  user: SessionUser,
  input: {
    device_id: string;
    screen_time_minutes?: number;
    apps?: unknown;
    browser_history?: unknown;
    hidden_apps?: unknown;
  },
) {
  const device = await d.collection(FAMILY_DEVICES).doc(input.device_id).get();
  if (!device.exists || device.data()?.user_id !== user.uid || device.data()?.revoked_at) throw new RpcError("NOT_FOUND", 404);
  const familyId = String(device.data()?.family_id ?? "");
  const memberId = String(device.data()?.member_id ?? "");
  const apps = sanitizeApps(input.apps);
  const explicitHidden = sanitizeApps(input.hidden_apps);
  const seenHidden = new Set(explicitHidden.map((a) => `${a.name}:${a.package}`));
  const hiddenApps = [
    ...explicitHidden,
    ...apps.filter((a) => a.hidden && !seenHidden.has(`${a.name}:${a.package}`)),
  ];
  await d.collection(ACTIVITY).add({
    user_id: user.uid,
    family_id: familyId,
    member_id: memberId,
    device_id: input.device_id,
    screen_time_minutes: Math.max(0, Math.min(24 * 60, Math.round(input.screen_time_minutes ?? 0))),
    apps,
    browser_history: sanitizeHistory(input.browser_history),
    hidden_apps: hiddenApps,
    reported_at: nowTs(),
    created_at: nowTs(),
  });
  await device.ref.set({ last_seen_at: nowTs() }, { merge: true });
  return { ok: true };
}

function sanitizeApps(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.slice(0, 120) : "";
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

function sanitizeHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 300).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.slice(0, 500) : "";
    if (!url) return [];
    return [{
      url,
      title: typeof row.title === "string" ? row.title.slice(0, 200) : "",
      visited_at: typeof row.visited_at === "string" ? row.visited_at.slice(0, 40) : "",
    }];
  });
}

/** Unlink a family device (parent, or the device owner). */
export async function revokeFamilyDevice(d: Db, user: SessionUser, deviceId: string) {
  const ref = d.collection(FAMILY_DEVICES).doc(deviceId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  const isOwner = data.user_id === user.uid;
  if (!isOwner) await requireParent(d, user.uid, String(data.family_id));
  await ref.set({ revoked_at: nowTs(), mirror_state: "denied_by_parent" }, { merge: true });
  await endMirrorSessions(d, String(data.family_id), String(data.user_id), "device_unlinked");
  await audit(d, user.uid, "family.device_revoke", deviceId, {});
  return { ok: true };
}

export async function listFamilyDevices(d: Db, user: SessionUser, familyId: string) {
  await requireMember(d, user.uid, familyId);
  const snap = await d.collection(FAMILY_DEVICES).where("family_id", "==", familyId).get();
  return snap.docs
    .filter((doc) => !doc.data().revoked_at)
    .map((doc) => ({
      id: doc.id,
      user_id: String(doc.data().user_id ?? ""),
      member_id: String(doc.data().member_id ?? ""),
      device_name: String(doc.data().device_name ?? "Device"),
      platform: String(doc.data().platform ?? "web"),
      device_type: String(doc.data().device_type ?? "browser"),
      last_seen_at: iso(doc.data().last_seen_at),
      live: millis(doc.data().last_seen_at) > Date.now() - DEVICE_LIVE_WINDOW_MS,
      mirror_state: (doc.data().mirror_state ?? "never") as MirrorState,
    }));
}

/** Convenience for the RPC layer/tests: the shared adminDb handle. */
export function familyDb(): Db {
  return adminDb();
}

export { env };
