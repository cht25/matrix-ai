// Canonical admin permission codes (seeded into `admin_permissions`).
// Kept free of server-only imports so client UI and tests can share it.

export const ALL_ADMIN_PERMISSION_CODES = [
  "admin.manage",
  "users.view",
  "users.view_pii",
  "verification.review",
  "consent.review",
  "content.manage",
  "reports.view",
  "security.view",
  "ai.view",
  "learning.view",
  "certificates.view",
  "audit.view",
  "privacy.access",
  "system.settings",
] as const;

export type AdminPermissionCode = (typeof ALL_ADMIN_PERMISSION_CODES)[number];

/** Legacy RPC name — the seed only has `reports.view` ("view and update"). */
export function normalizeAdminPermission(code: string): string {
  if (code === "reports.manage") return "reports.view";
  return code;
}

export function hasAdminCode(codes: readonly string[], code: string): boolean {
  return codes.includes(normalizeAdminPermission(code));
}
