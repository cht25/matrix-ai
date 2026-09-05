// =============================================================================
// MATRIX AI — CANONICAL ADMIN ROLE CATALOG (single source of truth).
//
// Before this file existed, the admin role list was declared in FOUR places:
//   1. seed/0007_seed.sql            → 5 roles
//   2. scripts/set-admin.mjs (docs)  → 5 roles
//   3. src/components/admin/users-tab.tsx (hard-coded <option>s) → 5 roles
//   4. rpc.seedAdminRbac()           → only 3 roles (super_admin, support_admin, auditor)
//
// `adminSetUserRole` validated the incoming role by checking whether
// `admin_roles/{role}` existed in Firestore. On any deployment bootstrapped
// through /admin/setup (which calls seedAdminRbac) the docs for
// `security_admin` and `content_admin` were NEVER created — so picking either
// of them in the UI threw RpcError("ROLE_INVALID").
//
// Everything (validation, seeding, permission matrix, the UI selector) now
// derives from the definitions below. No layer may invent its own list.
//
// This module must stay free of server-only imports: it is imported by client
// components, server RPC code, tests and the seed scripts.
// =============================================================================

import { ALL_ADMIN_PERMISSION_CODES, type AdminPermissionCode } from "@/lib/admin-rbac";

export type AdminRoleId =
  | "super_admin"
  | "security_admin"
  | "content_admin"
  | "support_admin"
  | "auditor";

/** Sentinel accepted by the role mutation to remove all admin access. */
export const NO_ROLE = "none" as const;

export type AdminRoleDefinition = {
  id: AdminRoleId;
  /** Human label shown in the UI — never show the raw id as the primary text. */
  label: string;
  description: string;
  /** Permission codes granted by this role. */
  permissions: readonly AdminPermissionCode[];
  /** Tailwind accent token used by badges so roles read consistently. */
  tone: "primary" | "secondary" | "warning" | "muted";
};

export const ADMIN_ROLES: readonly AdminRoleDefinition[] = [
  {
    id: "super_admin",
    label: "Super administrator",
    description: "Full platform access, including role management and system settings.",
    permissions: [...ALL_ADMIN_PERMISSION_CODES],
    tone: "primary",
  },
  {
    id: "security_admin",
    label: "Security administrator",
    description: "Verification, guardian consent, safety events, reports and privacy access.",
    permissions: [
      "users.view",
      "users.view_pii",
      "verification.review",
      "consent.review",
      "security.view",
      "reports.view",
      "ai.view",
      "certificates.view",
      "audit.view",
      "privacy.access",
    ],
    tone: "secondary",
  },
  {
    id: "content_admin",
    label: "Content administrator",
    description: "Scam library, courses, lessons and learning resources.",
    permissions: ["content.manage", "learning.view", "certificates.view", "reports.view"],
    tone: "secondary",
  },
  {
    id: "support_admin",
    label: "Support administrator",
    description: "User lookups, consent review and scam report triage.",
    permissions: ["users.view", "reports.view", "consent.review"],
    tone: "warning",
  },
  {
    id: "auditor",
    label: "Auditor",
    description: "Read-only access to audit logs, AI safety and security events.",
    permissions: ["audit.view", "ai.view", "security.view", "certificates.view"],
    tone: "muted",
  },
] as const;

export const ADMIN_ROLE_IDS: readonly AdminRoleId[] = ADMIN_ROLES.map((r) => r.id);

export function isAdminRoleId(value: unknown): value is AdminRoleId {
  return typeof value === "string" && (ADMIN_ROLE_IDS as readonly string[]).includes(value);
}

/** Accepts any canonical role id or the `none` sentinel. */
export function isAssignableRoleValue(value: unknown): value is AdminRoleId | typeof NO_ROLE {
  return value === NO_ROLE || isAdminRoleId(value);
}

/**
 * Tolerate legacy / differently-cased inputs (older records, scripts and the
 * pre-fix UI). Returns null when the value cannot be mapped to a real role.
 */
export function normalizeRoleInput(value: unknown): AdminRoleId | typeof NO_ROLE | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw || raw === "none" || raw === "user" || raw === "remove" || raw === "revoke") return NO_ROLE;
  const legacy: Record<string, AdminRoleId> = {
    admin: "super_admin",
    superadmin: "super_admin",
    super: "super_admin",
    owner: "super_admin",
    moderator: "support_admin",
    support: "support_admin",
    security: "security_admin",
    content: "content_admin",
    editor: "content_admin",
    audit: "auditor",
    read_only: "auditor",
  };
  if (isAdminRoleId(raw)) return raw;
  return legacy[raw] ?? null;
}

export function roleDefinition(id: string | null | undefined): AdminRoleDefinition | null {
  if (!id) return null;
  return ADMIN_ROLES.find((r) => r.id === id) ?? null;
}

export function roleLabel(id: string | null | undefined): string {
  return roleDefinition(id)?.label ?? "Standard user";
}

export function permissionsForRole(id: string | null | undefined): readonly AdminPermissionCode[] {
  return roleDefinition(id)?.permissions ?? [];
}

/** Role → permission matrix, as consumed by the seeder and the UI preview. */
export const ROLE_PERMISSION_MATRIX: Record<AdminRoleId, readonly AdminPermissionCode[]> =
  Object.fromEntries(ADMIN_ROLES.map((r) => [r.id, r.permissions])) as Record<
    AdminRoleId,
    readonly AdminPermissionCode[]
  >;

/** Friendly labels for permission codes (used by the permission preview). */
export const PERMISSION_LABELS: Record<string, string> = {
  "admin.manage": "Manage admin roles",
  "users.view": "View users",
  "users.view_pii": "View personal data",
  "verification.review": "Review age verification",
  "consent.review": "Review guardian consent",
  "content.manage": "Manage courses & scam library",
  "reports.view": "Handle scam reports",
  "security.view": "Security events",
  "ai.view": "AI safety & usage",
  "learning.view": "Learning progress",
  "certificates.view": "Certificates",
  "audit.view": "Audit logs",
  "privacy.access": "Privacy access requests",
  "system.settings": "System settings",
};

export function permissionLabel(code: string): string {
  return PERMISSION_LABELS[code] ?? code;
}
