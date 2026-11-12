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

/**
 * Features a parent may manage on a linked child device. Scoped, revocable, and
 * each one is surfaced to the child — nothing is enabled silently.
 */
export const CHILD_DEVICE_FEATURES = [
  "chat_history_view",
  "screen_time",
  "app_usage_view",
  "browser_history_view",
  "hidden_apps_view",
  "device_lock",
  "mirror_screen",
  "notifications",
] as const;
export type ChildDeviceFeature = (typeof CHILD_DEVICE_FEATURES)[number];

export function isChildDeviceFeature(value: unknown): value is ChildDeviceFeature {
  return typeof value === "string" && (CHILD_DEVICE_FEATURES as readonly string[]).includes(value);
}

export const FEATURE_LABEL: Record<ChildDeviceFeature, string> = {
  chat_history_view: "MATRIX chat history",
  screen_time: "Screen time",
  app_usage_view: "App usage",
  browser_history_view: "Browser history",
  hidden_apps_view: "Hidden / sideloaded apps",
  device_lock: "Remote lock",
  mirror_screen: "Screen mirroring",
  notifications: "Notifications",
};

export const FEATURE_DESCRIPTION: Record<ChildDeviceFeature, string> = {
  chat_history_view: "Read this member's MATRIX conversations.",
  screen_time: "Daily screen-time totals and limits reported by the device.",
  app_usage_view: "Per-app usage time, including hidden or sideloaded apps.",
  browser_history_view: "Visited sites reported by the companion app on the device.",
  hidden_apps_view: "Apps installed outside the store, or hidden from the launcher.",
  device_lock: "Remotely lock the device until it is unlocked in person.",
  mirror_screen: "Watch the live screen. Always visibly announced on the device.",
  notifications: "Deliver family alerts to the device.",
};

/**
 * Screen mirroring is a two-key lock: the parent must hold `mirror_screen`, AND
 * the device must have an active consent grant. A child revoking consent stops
 * every session immediately and can only be undone by a parent granting access
 * again — exactly the Google Family Link behaviour the product promises.
 */
export const MIRROR_STATES = ["never", "granted", "revoked_by_child", "denied_by_parent", "expired"] as const;
export type MirrorState = (typeof MIRROR_STATES)[number];

export function isMirrorState(value: unknown): value is MirrorState {
  return typeof value === "string" && (MIRROR_STATES as readonly string[]).includes(value);
}

/** Can the parent start a viewing session right now? */
export function mirrorAllowed(state: MirrorState, featureEnabled: boolean, parentHoldsFeature: boolean): boolean {
  return state === "granted" && featureEnabled && parentHoldsFeature;
}

/**
 * May `actor` (with family role `actorRole`) manage `target` (family role
 * `targetRole`) inside a family? Parents manage children only — never other
 * parents, and never anything outside the family.
 *
 * The primary parent is the exception handled in `canChangeRole`: they may
 * demote another parent, because otherwise a family could be locked by a
 * parent who left. Everyone else follows the parent→child rule.
 */
export function canManageFamilyMember(actorRole: FamilyRole, targetRole: FamilyRole): boolean {
  return actorRole === "parent" && targetRole === "child";
}

export type RoleChangeActor = {
  role: FamilyRole;
  isPrimary: boolean;
};

/**
 * Decide whether a role change is allowed.
 *
 * Rules:
 *  · a child can never change anyone's role;
 *  · a parent can promote a child to parent (co-parenting);
 *  · a parent cannot demote another parent;
 *  · the PRIMARY parent may demote a co-parent, but never the last parent.
 */
export function canChangeRole(input: {
  actor: RoleChangeActor;
  targetRole: FamilyRole;
  targetIsPrimary: boolean;
  nextRole: FamilyRole;
  activeParentCount: number;
}): boolean {
  const { actor, targetRole, targetIsPrimary, nextRole, activeParentCount } = input;
  if (actor.role !== "parent") return false;
  if (targetRole === nextRole) return false;
  // Never leave a family without a parent.
  if (targetRole === "parent" && nextRole === "child" && activeParentCount <= 1) return false;
  if (targetRole === "child" && nextRole === "parent") return true;
  if (targetRole === "parent" && nextRole === "child") {
    if (targetIsPrimary) return false; // the primary parent is never demoted
    return actor.isPrimary;
  }
  return false;
}

/** A child must never hold org-level administration. */
export function assertRoleAssignmentAllowed(accountRole: AccountRole, familyRole: FamilyRole | null): void {
  if (familyRole === "child" && (accountRole === "org_admin" || accountRole === "support_operator")) {
    throw new Error("ROLE_CONFLICT: a family child cannot hold an organization-level role");
  }
}

/**
 * Family invitations are resendable: the bearer link stays usable for 7 days,
 * and a resend rotates the token so an old forward can never be reused.
 * Existing stored expirations are preserved.
 */
export const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
/** Family device pairing links live for one hour. */
export const FAMILY_PAIRING_TTL_MS = 1000 * 60 * 60;
/** A mirror session must be renewed at least this often or it auto-stops. */
export const MIRROR_SESSION_TTL_MS = 1000 * 60 * 2;
/** Activity snapshots older than this are ignored for "live" status. */
export const DEVICE_LIVE_WINDOW_MS = 1000 * 60 * 5;

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
  is_primary?: boolean;
  features?: ChildDeviceFeature[];
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
  resend_count?: number;
  last_sent_at?: unknown;
};

/** Public, browser-safe shape of a family member (never leaks secrets). */
export type FamilyMemberSummary = {
  member_id: string;
  user_id: string;
  role: FamilyRole;
  is_primary: boolean;
  is_me: boolean;
  invited_by: string | null;
  joined_at: string;
  /** Profile projection so the family page can show who is who. */
  display_name: string;
  email: string;
  avatar_url: string;
  country: string;
  /** Devices this member uses, including family-linked ones. */
  devices: Array<{
    id: string;
    device_name: string;
    platform: string;
    device_type: string;
    last_seen_at: string;
    live: boolean;
    mirror_state: MirrorState;
    family_linked: boolean;
  }>;
  features: ChildDeviceFeature[];
  mirror_state: MirrorState;
  device_locked?: boolean;
  device_lock_reason?: string;
  /** Latest opt-in report from the companion app (null until one is sent). */
  activity: FamilyActivitySnapshot | null;
};

export type FamilyAppUsage = {
  name: string;
  package: string;
  minutes: number;
  hidden: boolean;
  last_used: string;
};

export type FamilyBrowserVisit = { url: string; title: string; visited_at: string };

export type FamilyActivitySnapshot = {
  reported_at: string;
  device_id: string;
  screen_time_minutes: number;
  apps: FamilyAppUsage[];
  browser_history: FamilyBrowserVisit[];
  hidden_apps: FamilyAppUsage[];
};

export type FamilyInvitationSummary = {
  invitation_id: string;
  invitee_email: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expires_at: string;
  created_at: string;
  resend_count: number;
  last_sent_at: string;
  email_status: string;
};

export type FamilyListRow = {
  family_id: string;
  role: FamilyRole;
  name: string;
  member_count: number;
  is_primary: boolean;
  pending_invitations: number;
};

export type FamilyOverview = {
  family: { family_id: string; name: string; created_at: string };
  me: {
    member_id: string;
    role: FamilyRole;
    is_primary: boolean;
    features: ChildDeviceFeature[];
    mirror_state: MirrorState;
    device_locked?: boolean;
    device_lock_reason?: string;
  };
  members: FamilyMemberSummary[];
  invitations: FamilyInvitationSummary[];
  member_count: number;
  parent_count: number;
};
