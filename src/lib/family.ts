// =============================================================================
// MATRIX AI — Family domain: shared role model and pure authorization logic.
//
// Account roles are SEPARATE from family membership:
//   - account_role lives on the profile and describes platform standing
//     (individual / org_admin / support_operator).
//   - family_role (parent | child) describes a relationship inside one family.
// A child in a family must NEVER become an org admin because of that
// membership, and an org admin gets NO implicit access to private family data.
//
// This module is client-safe (no server-only imports) so UI, RPC and tests
// share one source of truth.
// =============================================================================

export type AccountRole = "individual" | "org_admin" | "support_operator";
export type FamilyRole = "parent" | "child";

export const ACCOUNT_ROLES: readonly AccountRole[] = ["individual", "org_admin", "support_operator"];
export const FAMILY_ROLES: readonly FamilyRole[] = ["parent", "child"];

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (ACCOUNT_ROLES as readonly string[]).includes(value);
}
export function isFamilyRole(value: unknown): value is FamilyRole {
  return typeof value === "string" && (FAMILY_ROLES as readonly string[]).includes(value);
}

export const DEFAULT_ACCOUNT_ROLE: AccountRole = "individual";

/** Features a parent may manage on a linked child device. Scoped, revocable. */
export const CHILD_DEVICE_FEATURES = [
  "chat_history_view",
  "screen_time",
  "app_usage_view",
  "device_lock",
  "notifications",
] as const;
export type ChildDeviceFeature = (typeof CHILD_DEVICE_FEATURES)[number];

export function isChildDeviceFeature(value: unknown): value is ChildDeviceFeature {
  return typeof value === "string" && (CHILD_DEVICE_FEATURES as readonly string[]).includes(value);
}

/**
 * May `actor` (with family role `actorRole`) manage `target` (family role
 * `targetRole`) inside a family? Parents manage children only — never other
 * parents, and never anything outside the family.
 */
export function canManageFamilyMember(actorRole: FamilyRole, targetRole: FamilyRole): boolean {
  return actorRole === "parent" && targetRole === "child";
}

/** A child must never hold org-level administration. */
export function assertRoleAssignmentAllowed(accountRole: AccountRole, familyRole: FamilyRole | null): void {
  if (familyRole === "child" && (accountRole === "org_admin" || accountRole === "support_operator")) {
    throw new Error("ROLE_CONFLICT: a family child cannot hold an organization-level role");
  }
}

/** Family invitations expire after this long. */
export const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** Deterministic membership doc id: one membership per (user, family). */
export function membershipDocId(uid: string, familyId: string): string {
  return `${uid}_${familyId}`;
}

export type FamilyDoc = {
  name: string;
  created_by: string;
  created_at: unknown;
  updated_at: unknown;
};

export type FamilyMemberDoc = {
  user_id: string;
  family_id: string;
  role: FamilyRole;
  invited_by?: string;
  joined_at: unknown;
  revoked_at: unknown | null;
};

export type FamilyInvitationDoc = {
  family_id: string;
  invited_by: string;
  invitee_email: string;
  token_hash: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expires_at: unknown;
  created_at: unknown;
  resolved_at: unknown | null;
};
