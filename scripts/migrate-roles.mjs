#!/usr/bin/env node
// =============================================================================
// MATRIX AI — role catalog repair migration (safe, idempotent, non-destructive).
//
//   node scripts/migrate-roles.mjs --dry-run   # report only, writes nothing
//   node scripts/migrate-roles.mjs             # apply
//
// WHY THIS EXISTS
// The old seeder (rpc.seedAdminRbac) only created 3 of the 5 admin_roles
// documents. Role assignment validated by checking whether admin_roles/{role}
// existed, so choosing `security_admin` or `content_admin` failed with
// ROLE_INVALID on any deployment bootstrapped through /admin/setup.
//
// WHAT IT DOES
//   1. Reports the current admin_roles / admin_permissions / assignment state.
//   2. Creates any MISSING canonical role + permission + role-permission link.
//   3. Normalises legacy values in admin_role_assignments (e.g. "admin",
//      "ADMIN", "Super Admin" -> "super_admin"); unmappable values are
//      REPORTED, never deleted.
//
// It never deletes a user, a profile, or an assignment it cannot map. Existing
// documents are merged, not overwritten.
// =============================================================================

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY = process.argv.includes("--dry-run");

const PERMISSIONS = [
  "admin.manage", "users.view", "users.view_pii", "verification.review",
  "consent.review", "content.manage", "reports.view", "security.view",
  "ai.view", "learning.view", "certificates.view", "audit.view",
  "privacy.access", "system.settings",
];

// Mirrors src/lib/roles.ts — the single source of truth.
const ROLES = [
  { id: "super_admin", label: "Super administrator", permissions: PERMISSIONS },
  {
    id: "security_admin", label: "Security administrator",
    permissions: ["users.view", "users.view_pii", "verification.review", "consent.review", "security.view", "reports.view", "ai.view", "certificates.view", "audit.view", "privacy.access"],
  },
  { id: "content_admin", label: "Content administrator", permissions: ["content.manage", "learning.view", "certificates.view", "reports.view"] },
  { id: "support_admin", label: "Support administrator", permissions: ["users.view", "reports.view", "consent.review"] },
  { id: "auditor", label: "Auditor", permissions: ["audit.view", "ai.view", "security.view", "certificates.view"] },
];
const ROLE_IDS = ROLES.map((r) => r.id);

const LEGACY = {
  admin: "super_admin", superadmin: "super_admin", super: "super_admin", owner: "super_admin",
  moderator: "support_admin", support: "support_admin", security: "security_admin",
  content: "content_admin", editor: "content_admin", audit: "auditor", read_only: "auditor",
};

function normalise(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ROLE_IDS.includes(raw)) return raw;
  return LEGACY[raw] ?? null;
}

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!projectId || !clientEmail || !privateKey) {
  console.error("Missing FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / project id env vars.");
  process.exit(1);
}

initializeApp({ projectId, credential: cert({ projectId, clientEmail, privateKey }) });
const db = getFirestore();

console.log(`\nMATRIX role migration — ${DRY ? "DRY RUN (no writes)" : "APPLYING"}\n`);

// --- 1. inspect -------------------------------------------------------------
const [rolesSnap, permsSnap, linksSnap, assignSnap] = await Promise.all([
  db.collection("admin_roles").get(),
  db.collection("admin_permissions").get(),
  db.collection("admin_role_permissions").get(),
  db.collection("admin_role_assignments").get(),
]);

const existingRoles = new Set(rolesSnap.docs.map((d) => d.id));
const existingPerms = new Set(permsSnap.docs.map((d) => d.id));
const existingLinks = new Set(linksSnap.docs.map((d) => d.id));

console.log("Current state");
console.log(`  admin_roles            : ${rolesSnap.size} (${[...existingRoles].join(", ") || "none"})`);
console.log(`  admin_permissions      : ${permsSnap.size}`);
console.log(`  admin_role_permissions : ${linksSnap.size}`);
console.log(`  admin_role_assignments : ${assignSnap.size}\n`);

// --- 2. add missing catalog documents --------------------------------------
let created = 0;
for (const role of ROLES) {
  if (!existingRoles.has(role.id)) {
    console.log(`  + admin_roles/${role.id}`);
    if (!DRY) await db.collection("admin_roles").doc(role.id).set({ name: role.label, updated_at: new Date() }, { merge: true });
    created++;
  }
}
for (const code of PERMISSIONS) {
  if (!existingPerms.has(code)) {
    console.log(`  + admin_permissions/${code}`);
    if (!DRY) await db.collection("admin_permissions").doc(code).set({ code, updated_at: new Date() }, { merge: true });
    created++;
  }
}
for (const role of ROLES) {
  for (const code of role.permissions) {
    const id = `${role.id}__${code}`;
    if (!existingLinks.has(id)) {
      console.log(`  + admin_role_permissions/${id}`);
      if (!DRY) await db.collection("admin_role_permissions").doc(id).set({ role_id: role.id, permission_id: code, updated_at: new Date() }, { merge: true });
      created++;
    }
  }
}

// --- 3. normalise legacy assignment values ---------------------------------
let fixed = 0;
const unmappable = [];
for (const doc of assignSnap.docs) {
  const current = doc.data()?.role_id;
  const mapped = normalise(current);
  if (mapped === null) {
    unmappable.push({ uid: doc.id, role_id: current });
    continue;
  }
  if (mapped !== current) {
    console.log(`  ~ admin_role_assignments/${doc.id}: "${current}" -> "${mapped}"`);
    if (!DRY) await doc.ref.set({ role_id: mapped, migrated_from: current, updated_at: new Date() }, { merge: true });
    fixed++;
  }
}

console.log(`\nSummary`);
console.log(`  catalog documents created : ${created}`);
console.log(`  assignments normalised    : ${fixed}`);
if (unmappable.length) {
  console.log(`\n  ⚠ ${unmappable.length} assignment(s) could NOT be mapped and were left untouched:`);
  for (const u of unmappable) console.log(`      ${u.uid} -> ${JSON.stringify(u.role_id)}`);
  console.log("  Review these manually with scripts/set-admin.mjs. Nothing was deleted.");
}
console.log(DRY ? "\nDry run complete — no data was modified.\n" : "\nMigration complete. No user records were deleted.\n");
process.exit(0);
