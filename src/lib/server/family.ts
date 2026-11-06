// =============================================================================
// MATRIX AI — Family backend (server-only). All mutations run here through
// /api/rpc; Firestore rules deny every browser write. Every privileged check
// (membership, parent role, child protection) is enforced in code, not UI.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { familyInvitationUrl, sendFamilyInvitation } from "@/lib/server/family-email";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb, nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";
import {
  INVITATION_TTL_MS,
  canManageFamilyMember,
  isFamilyRole,
  membershipDocId,
  type FamilyRole,
} from "@/lib/family";

export { RpcError };

const FAMILIES = "families";
const MEMBERS = "family_members";
const INVITATIONS = "family_invitations";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function getActiveMembership(d: Db, uid: string, familyId: string) {
  const snap = await d.collection(MEMBERS).doc(membershipDocId(uid, familyId)).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (data.revoked_at) return null;
  return { id: snap.id, ...data } as { id: string; user_id: string; family_id: string; role: FamilyRole };
}

async function requireMember(d: Db, uid: string, familyId: string, role?: FamilyRole) {
  const membership = await getActiveMembership(d, uid, familyId);
  if (!membership) throw new RpcError("NOT_A_MEMBER", 403);
  if (role && membership.role !== role) throw new RpcError("PERMISSION_DENIED", 403);
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

export async function createFamily(d: Db, user: SessionUser, input: { name: string }) {
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) throw new RpcError("NAME_INVALID");
  const familyRef = d.collection(FAMILIES).doc();
  const now = nowTs();
  await familyRef.set({ name, created_by: user.uid, created_at: now, updated_at: now });
  await d.collection(MEMBERS).doc(membershipDocId(user.uid, familyRef.id)).set({
    user_id: user.uid,
    family_id: familyRef.id,
    role: "parent",
    joined_at: now,
    revoked_at: null,
  });
  await audit(d, user.uid, "family.create", familyRef.id, { name });
  return { family_id: familyRef.id, name, role: "parent" as const };
}

export async function inviteMember(d: Db, user: SessionUser, input: { family_id: string; invitee_email: string }) {
  await requireMember(d, user.uid, input.family_id, "parent");
  const email = input.invitee_email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new RpcError("EMAIL_INVALID");
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
    resolved_at: null,
  });
  await audit(d, user.uid, "family.invite", ref.id, { family_id: input.family_id, invitee_email: email });
  const delivery = await sendFamilyInvitation({ id: ref.id, email, token, expiresAt });
  await ref.set({ email_status: delivery.status, email_provider_id: delivery.provider_id ?? null }, { merge: true });
  return {
    invitation_id: ref.id, token, expires_at: expiresAt, email_status: delivery.status,
    qr_data_url: await QRCode.toDataURL(familyInvitationUrl(token), { width: 256, margin: 2 }),
  };
}

/** Only the intended verified recipient can review a bearer invitation. */
export async function reviewInvitation(d: Db, user: SessionUser, token: string) {
  const snap = await d.collection(INVITATIONS).where("token_hash", "==", hashToken(token)).limit(1).get();
  if (snap.empty) throw new RpcError("INVITATION_INVALID", 404);
  const invite = snap.docs[0].data();
  if (invite.status !== "pending") throw new RpcError("INVITATION_INVALID", 409);
  if (Date.now() >= ((invite.expires_at as Timestamp)?.toMillis?.() ?? 0)) throw new RpcError("INVITATION_EXPIRED", 410);
  if (!user.emailVerified || user.email?.trim().toLowerCase() !== invite.invitee_email) throw new RpcError("INVITATION_EMAIL_MISMATCH", 403);
  const family = await d.collection(FAMILIES).doc(String(invite.family_id)).get();
  if (!family.exists) throw new RpcError("INVITATION_INVALID", 404);
  return { name: String(family.data()?.name ?? "Family"), role: "child" as const, expires_at: (invite.expires_at as Timestamp).toDate().toISOString() };
}

export async function acceptInvitation(d: Db, user: SessionUser, input: { token: string }) {
  const snap = await d.collection(INVITATIONS).where("token_hash", "==", hashToken(input.token)).limit(1).get();
  if (snap.empty) throw new RpcError("INVITATION_INVALID", 404);
  const invitationRef = d.collection(INVITATIONS).doc(snap.docs[0].id);
  // Re-read and consume atomically: concurrent accepts must not reuse a token.
  const familyId = await d.runTransaction(async (tx) => {
    const invite = await tx.get(invitationRef);
    const data = invite.data();
    if (!data || data.status !== "pending") throw new RpcError("INVITATION_INVALID", 409);
    if (Date.now() >= ((data.expires_at as Timestamp)?.toMillis?.() ?? 0)) throw new RpcError("INVITATION_EXPIRED", 410);
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
    tx.set(memberRef, { user_id: user.uid, family_id: id, role: "child", invited_by: data.invited_by, joined_at: now, revoked_at: null });
    tx.set(invitationRef, { status: "accepted", resolved_at: now }, { merge: true });
    return id;
  });
  await audit(d, user.uid, "family.join", familyId, { invitation_id: invitationRef.id });
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

export async function changeMemberRole(d: Db, user: SessionUser, input: { family_id: string; member_id: string; role: string }) {
  await requireMember(d, user.uid, input.family_id, "parent");
  if (!isFamilyRole(input.role)) throw new RpcError("ROLE_INVALID");
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id) throw new RpcError("NOT_A_MEMBER", 404);
  const targetRole = target.data()?.role as FamilyRole;
  // A parent cannot demote another parent; only parent<->child transitions.
  if (targetRole === "parent" && input.role !== "parent") throw new RpcError("PERMISSION_DENIED", 403);
  await target.ref.set({ role: input.role, updated_at: nowTs() }, { merge: true });
  await audit(d, user.uid, "family.role_change", input.member_id, { family_id: input.family_id, role: input.role });
  return { member_id: input.member_id, role: input.role };
}

export async function revokeMember(d: Db, user: SessionUser, input: { family_id: string; member_id: string }) {
  const actor = await requireMember(d, user.uid, input.family_id);
  const target = await d.collection(MEMBERS).doc(input.member_id).get();
  if (!target.exists || target.data()?.family_id !== input.family_id) throw new RpcError("NOT_A_MEMBER", 404);
  const targetRole = target.data()?.role as FamilyRole;
  // Parents can revoke children; a member can revoke themselves (leave).
  const selfRevoke = input.member_id === membershipDocId(user.uid, input.family_id);
  if (!selfRevoke && !canManageFamilyMember(actor.role, targetRole)) throw new RpcError("PERMISSION_DENIED", 403);
  await target.ref.set({ revoked_at: nowTs() }, { merge: true });
  await audit(d, user.uid, "family.revoke", input.member_id, { family_id: input.family_id, self: selfRevoke });
  return true;
}

export async function listFamiliesForUser(d: Db, uid: string) {
  const snap = await d.collection(MEMBERS).where("user_id", "==", uid).get();
  const out: Array<{ family_id: string; role: FamilyRole; name: string; member_count: number }> = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.revoked_at) continue;
    const family = await d.collection(FAMILIES).doc(String(data.family_id)).get();
    if (!family.exists) continue;
    const members = await d
      .collection(MEMBERS)
      .where("family_id", "==", data.family_id)
      .get();
    const active = members.docs.filter((m) => !m.data().revoked_at).length;
    out.push({ family_id: data.family_id, role: data.role, name: String(family.data()?.name ?? ""), member_count: active });
  }
  return out;
}

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
      joined_at: m.data().joined_at?.toDate?.().toISOString() ?? "",
    }));
}

/** Convenience for the RPC layer/tests: the shared adminDb handle. */
export function familyDb(): Db {
  return adminDb();
}
