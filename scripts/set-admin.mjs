#!/usr/bin/env node
// =============================================================================
// MATRIX AI — promote a user to an admin role (replaces scripts/promote-admin.sql).
//
//   node scripts/set-admin.mjs <email> [role]
//   role: super_admin | security_admin | content_admin | support_admin | auditor
//
// Creates admin_role_assignments/{uid} in Firestore (the authoritative RBAC
// source used by has_permission/is_admin) and sets the `admin: true` custom
// claim (used by firestore.rules/storage.rules and middleware).
//
// Run AFTER scripts/seed.mjs (roles must exist). Demote: `node scripts/set-admin.mjs <email> none`.
// =============================================================================

import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const [email, roleArg = "super_admin"] = process.argv.slice(2);
if (!email) {
  console.error("Usage: node scripts/set-admin.mjs <email> [role|none]");
  process.exit(1);
}

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID;
const serviceEmail = process.env.FIREBASE_CLIENT_EMAIL;
const serviceKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!projectId || !serviceEmail || !serviceKey) {
  console.error("Missing FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / project id env vars.");
  process.exit(1);
}

initializeApp({ projectId, credential: cert({ projectId, clientEmail: serviceEmail, privateKey: serviceKey }) });
const auth = getAuth();
const db = getFirestore();

const user = await auth.getUserByEmail(email).catch(() => null);
if (!user) {
  console.error(`No Firebase Auth user with email ${email}. They must sign up first.`);
  process.exit(1);
}

if (roleArg === "none") {
  await db.collection("admin_role_assignments").doc(user.uid).delete();
  await auth.setCustomUserClaims(user.uid, { admin: false });
  console.log(`✅ ${email} demoted — admin access removed.`);
  process.exit(0);
}

// Canonical role list — kept in sync with src/lib/roles.ts (single source of
// truth). We validate against the catalog, NOT against whatever documents
// happen to exist in Firestore, so a partially seeded database cannot make a
// legitimate role look invalid.
const CANONICAL_ROLES = ["super_admin", "security_admin", "content_admin", "support_admin", "auditor"];
if (!CANONICAL_ROLES.includes(roleArg)) {
  console.error(`Unknown role "${roleArg}". Valid roles: ${CANONICAL_ROLES.join(", ")}, none.`);
  process.exit(1);
}
// Self-heal a missing role document rather than refusing the assignment.
const roleDoc = await db.collection("admin_roles").doc(roleArg).get();
if (!roleDoc.exists) {
  console.warn(`admin_roles/${roleArg} was missing — creating it. Run \`npm run seed\` to seed descriptions and permission links.`);
  await db.collection("admin_roles").doc(roleArg).set({ name: roleArg, created_at: new Date() }, { merge: true });
}

await db.collection("admin_role_assignments").doc(user.uid).set({
  role_id: roleArg,
  assigned_by: null,
  created_at: new Date(),
});
// The custom claim propagates to the user's token on next refresh (≤1h) or
// next sign-in; the Firestore assignment applies immediately server-side.
await auth.setCustomUserClaims(user.uid, { admin: true, role: roleArg });

console.log(`✅ ${email} is now ${roleArg}. The \`admin\` claim appears in their token after their next sign-in (or token refresh).`);
