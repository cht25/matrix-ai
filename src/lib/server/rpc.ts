// =============================================================================
// MATRIX AI — server-side RPC layer (Firebase port of supabase 0006 SQL).
//
// Every Postgres SECURITY DEFINER function is ported 1:1 to TypeScript on the
// Admin SDK. Clients can only reach these through Next.js API routes — the
// same "values computed server-side, never client" contract as before.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { Db, nowTs, toTs } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { descDoc } from "@/lib/server/sort";
import { identityHashes, maskLast4, validateCertNumber } from "@/lib/server/identity-number";
import { env, isIdentityPepperConfigured } from "@/lib/env";
import { isThemeMode, isThemeTemplateId } from "@/lib/theme-templates";
import { ALL_ADMIN_PERMISSION_CODES, normalizeAdminPermission } from "@/lib/admin-rbac";

export { RpcError } from "@/lib/server/errors";
import { RpcError } from "@/lib/server/errors";

// ---------------------------------------------------------------------------
// 1. HELPERS — DOB validation (registration requires 11 <= age <= 17)
// ---------------------------------------------------------------------------
export function calculateAge(dob: string): number {
  const birth = new Date(dob + "T00:00:00Z");
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

export function validateDob(dob: string | null | undefined): number {
  if (!dob) throw new RpcError("DOB_MISSING");
  const birth = new Date(dob + "T00:00:00Z");
  if (Number.isNaN(birth.getTime()) || birth > new Date()) throw new RpcError("DOB_FUTURE");
  const age = calculateAge(dob);
  if (age < 11) throw new RpcError("DOB_TOO_YOUNG");
  if (age > 17) throw new RpcError("DOB_TOO_OLD");
  return age;
}

// ---------------------------------------------------------------------------
// 2. AUTH → PROFILE PROVISIONING (port of handle_new_user trigger)
// Called from /api/auth/session on every sign-in; idempotent.
// ---------------------------------------------------------------------------
export async function ensureUserDocuments(
  auth: ReturnType<typeof import("firebase-admin/auth").getAuth>,
  d: Db,
  uid: string,
  email: string | null,
  displayName?: string,
): Promise<void> {
  let record: import("firebase-admin/auth").UserRecord | null = null;
  try {
    record = await auth.getUser(uid);
  } catch {
    record = null;
  }

  const profileRef = d.collection("profiles").doc(uid);
  const existing = await profileRef.get();
  const prev = existing.data();
  const fullName = (displayName || record?.displayName || prev?.full_name || "").toString().slice(0, 120);
  const photoURL = (record?.photoURL || "").toString().slice(0, 2000);

  await profileRef.set(
    {
      email: email ?? prev?.email ?? "",
      full_name: prev?.full_name ? prev.full_name : fullName,
      updated_at: nowTs(),
    },
    { merge: true },
  );
  if (!existing.exists) {
    await profileRef.set(
      {
        date_of_birth: "",
        age_verified: false,
        age_verified_at: null,
        school_name: "",
        class_grade: "",
        address: "",
        country: "",
        phone: "",
        avatar_url: photoURL,
        created_at: nowTs(),
      },
      { merge: true },
    );
  } else if (!String(prev?.avatar_url ?? "").trim() && photoURL) {
    await profileRef.set({ avatar_url: photoURL, updated_at: nowTs() }, { merge: true });
  }
  await d.collection("user_security_settings").doc(uid).set(
    {
      memory_enabled: true,
      chat_history_enabled: true,
      notifications_email: true,
      notifications_push: false,
      notifications_security_alerts: true,
      created_at: nowTs(),
      updated_at: nowTs(),
    },
    { merge: true },
  );
  // Track a device session row (users can revoke their own sessions).
  await d.collection("user_sessions").add({
    user_id: uid,
    session_ref: crypto.randomBytes(12).toString("hex"),
    device_name: "web",
    ip_hash: "",
    user_agent: "",
    last_seen_at: nowTs(),
    revoked_at: null,
    created_at: nowTs(),
  });
}

// ---------------------------------------------------------------------------
// 4. ONBOARDING
// ---------------------------------------------------------------------------
export async function completeProfile(
  d: Db,
  user: SessionUser,
  p: { dob: string; full_name?: string; school_name?: string; class_grade?: string; country?: string | null },
) {
  const age = validateDob(p.dob);
  let consentRequired = true;
  let minAge = 13;
  if (p.country) {
    const country = await d.collection("countries").doc(p.country).get();
    if (country.exists) {
      consentRequired = country.data()?.consent_required ?? true;
      minAge = country.data()?.consent_min_age ?? 13;
    }
  }
  await d.collection("profiles").doc(user.uid).set(
    {
      date_of_birth: p.dob,
      age_verified: false,
      age_verified_at: null,
      ...(p.full_name ? { full_name: p.full_name.slice(0, 120) } : {}),
      ...(p.school_name ? { school_name: p.school_name.slice(0, 120) } : {}),
      ...(p.class_grade ? { class_grade: p.class_grade.slice(0, 40) } : {}),
      ...(p.country ? { country: p.country } : {}),
      updated_at: nowTs(),
    },
    { merge: true },
  );

  // Consent workflow: self-consent auto-approves at/above the country consent
  // age; otherwise a guardian consent is required (pending review).
  const selfOk = !consentRequired || age >= minAge;
  await d.collection("guardian_consents").doc(user.uid).set(
    {
      status: selfOk ? "approved" : "pending",
      consent_method: selfOk ? "self" : "guardian",
      ...(selfOk ? { consented_at: nowTs() } : {}),
      updated_at: nowTs(),
    },
    { merge: true },
  );

  const consent = (await d.collection("guardian_consents").doc(user.uid).get()).data();
  return {
    age,
    consent_required: consentRequired,
    consent_status: consent?.status ?? "pending",
    identity_verification_required: true,
  };
}

export async function profileOnboardingComplete(d: Db, uid: string): Promise<boolean> {
  const [profile, verifications] = await Promise.all([
    d.collection("profiles").doc(uid).get(),
    d.collection("identity_verifications").where("user_id", "==", uid).get(),
  ]);
  const dob = String(profile.data()?.date_of_birth ?? "").trim();
  if (!dob) return false;
  const latest = verifications.docs.sort(descDoc("created_at"))[0];
  const status = latest?.data()?.verification_status as string | undefined;
  return status === "pending_review" || status === "approved";
}

export async function submitIdentityNumber(
  d: Db,
  user: SessionUser,
  p: { birth_certificate_number: string },
) {
  if (!isIdentityPepperConfigured()) throw new RpcError("IDENTITY_PEPPER_NOT_CONFIGURED", 503);
  const check = validateCertNumber(p.birth_certificate_number);
  if (!check.ok) throw new RpcError(check.reason);
  const hashes = identityHashes(env.identityPepper, user.uid, check.normalized);

  const recent = await d.collection("identity_verifications").where("user_id", "==", user.uid).get();
  const dayAgo = Date.now() - 86_400_000;
  const todayCount = recent.docs.filter((doc) => {
    const t = doc.data().created_at?.toDate?.()?.getTime?.() ?? 0;
    return t >= dayAgo;
  }).length;
  if (todayCount >= 5) throw new RpcError("CERT_NUMBER_RATE_LIMITED", 429);

  const dup = await d.collection("identity_verifications").where("identity_hash_global", "==", hashes.identity_hash_global).get();
  const taken = dup.docs.some((doc) => {
    const data = doc.data();
    if (data.user_id === user.uid) return false;
    return data.verification_status === "approved" || data.verification_status === "pending_review";
  });
  if (taken) throw new RpcError("CERT_NUMBER_IN_USE", 409);

  await d.collection("identity_verifications").add({
    user_id: user.uid,
    verification_type: "birth_certificate_number",
    verification_status: "pending_review",
    verification_reference: maskLast4(hashes.identity_last4),
    identity_hash: hashes.identity_hash,
    identity_hash_global: hashes.identity_hash_global,
    identity_last4: hashes.identity_last4,
    identity_hash_version: hashes.identity_hash_version,
    reviewer_id: null,
    rejection_reason: "",
    verified_at: null,
    created_at: nowTs(),
    updated_at: nowTs(),
  });
  return { submitted: true, masked: maskLast4(hashes.identity_last4) };
}

export async function submitGuardianConsent(
  d: Db,
  user: SessionUser,
  p: { guardian_name: string; guardian_email: string; relationship: string },
) {
  const name = p.guardian_name.trim();
  const email = p.guardian_email.trim().toLowerCase();
  if (name.length < 2 || !email.includes("@")) throw new RpcError("GUARDIAN_DETAILS_INVALID");
  const ref = d.collection("guardian_consents").doc(user.uid);
  const doc = await ref.get();
  if (!doc.exists) throw new RpcError("NOT_FOUND");
  await ref.set(
    {
      guardian_name: name.slice(0, 120),
      guardian_email: email.slice(0, 160),
      guardian_relationship: p.relationship.trim().slice(0, 60),
      status: "pending",
      updated_at: nowTs(),
    },
    { merge: true },
  );
  return true;
}

/** Identity verification submission (documents go to Cloud Storage first). */
export async function submitIdentityVerification(
  d: Db,
  user: SessionUser,
  p: { verification_type: string; verification_reference: string },
) {
  const allowed = ["birth_certificate", "passport", "national_id", "external_provider"];
  if (!allowed.includes(p.verification_type)) throw new RpcError("TYPE_INVALID");
  // Ownership: the document must live in the user's own Cloudinary folder.
  if (!p.verification_reference.startsWith(`identity-documents/${user.uid}/`)) throw new RpcError("STORAGE_OWNERSHIP_VIOLATION");
  await d.collection("identity_verifications").add({
    user_id: user.uid,
    verification_type: p.verification_type,
    verification_status: "pending_review",
    verification_reference: p.verification_reference,
    identity_hash: "",
    identity_hash_global: "",
    identity_last4: "",
    reviewer_id: null,
    rejection_reason: "",
    verified_at: null,
    created_at: nowTs(),
    updated_at: nowTs(),
  });
  return true;
}

export async function updateTheme(
  d: Db,
  user: SessionUser,
  p: { theme?: string; theme_template?: string },
) {
  const patch: Record<string, unknown> = { updated_at: nowTs() };
  if (isThemeMode(p.theme)) patch.theme = p.theme;
  if (isThemeTemplateId(p.theme_template)) patch.theme_template = p.theme_template;
  await d.collection("profiles").doc(user.uid).set(patch, { merge: true });
  await d.collection("user_security_settings").doc(user.uid).set(
    {
      ...(isThemeMode(p.theme) ? { theme: p.theme } : {}),
      ...(isThemeTemplateId(p.theme_template) ? { theme_template: p.theme_template } : {}),
      updated_at: nowTs(),
    },
    { merge: true },
  );
  return { theme: p.theme ?? null, theme_template: p.theme_template ?? null };
}

export async function listNotifications(d: Db, user: SessionUser) {
  const snap = await d.collection("notifications").where("user_id", "==", user.uid).get();
  return snap.docs
    .sort(descDoc("created_at"))
    .slice(0, 30)
    .map((doc) => ({
      id: doc.id,
      type: doc.data().type ?? "info",
      title: doc.data().title ?? "",
      body: doc.data().body ?? "",
      link: doc.data().link ?? "",
      read_at: doc.data().read_at ? doc.data().read_at.toDate?.().toISOString?.() ?? null : null,
      created_at: doc.data().created_at?.toDate?.().toISOString?.() ?? "",
    }));
}

export async function markNotificationsRead(d: Db, user: SessionUser, p: { id?: string; all?: boolean }) {
  if (p.all) {
    const snap = await d.collection("notifications").where("user_id", "==", user.uid).get();
    await Promise.all(
      snap.docs.filter((doc) => !doc.data().read_at).map((doc) => doc.ref.set({ read_at: nowTs() }, { merge: true })),
    );
    return true;
  }
  if (!p.id) throw new RpcError("NOT_FOUND", 404);
  const ref = d.collection("notifications").doc(p.id);
  const doc = await ref.get();
  if (!doc.exists || doc.data()!.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  await ref.set({ read_at: nowTs() }, { merge: true });
  return true;
}

export async function usageSummary(d: Db, user: SessionUser) {
  const snap = await d.collection("ai_usage_logs").where("user_id", "==", user.uid).get();
  const now = Date.now();
  let chatDay = 0;
  let scanDay = 0;
  for (const doc of snap.docs) {
    const raw = doc.data().created_at as { toMillis?: () => number; toDate?: () => Date } | undefined;
    const t = raw?.toMillis ? raw.toMillis() : raw?.toDate ? raw.toDate().getTime() : 0;
    if (!t || now - t >= 86_400_000) continue;
    if (doc.data().request_type === "chat") chatDay++;
    if (doc.data().request_type === "scan") scanDay++;
  }
  return { chat_used: chatDay, chat_limit: 300, scan_used: scanDay, scan_limit: 50 };
}

export async function adminRoleOf(d: Db, uid: string): Promise<string | null> {
  const assignment = await d.collection("admin_role_assignments").doc(uid).get();
  return assignment.exists ? (assignment.data()!.role_id as string) : null;
}

export async function bootstrapAdmin(d: Db, user: SessionUser, key: string) {
  const { isAdminBootstrapConfigured } = await import("@/lib/env");
  if (!isAdminBootstrapConfigured()) throw new RpcError("BOOTSTRAP_NOT_CONFIGURED", 503);
  if (key !== env.adminBootstrapKey) throw new RpcError("INVALID_BOOTSTRAP_KEY", 403);
  const existing = await d.collection("admin_role_assignments").limit(1).get();
  if (!existing.empty) throw new RpcError("BOOTSTRAP_CLOSED", 409);
  await d.collection("admin_role_assignments").doc(user.uid).set({
    role_id: "super_admin",
    assigned_by: user.uid,
    created_at: nowTs(),
  });
  await seedAdminRbac(d);
  const auth = (await import("firebase-admin/auth")).getAuth();
  await auth.setCustomUserClaims(user.uid, { admin: true, role: "super_admin" });
  await logAudit(d, user.uid, "admin_bootstrap", "admin_role_assignments", user.uid, "first super_admin");
  return { role: "super_admin" };
}

/** Idempotent seed of roles + permission codes so non-super roles have links. */
export async function seedAdminRbac(d: Db) {
  const roles = [
    { id: "super_admin", name: "Super admin" },
    { id: "support_admin", name: "Support" },
    { id: "auditor", name: "Auditor" },
  ];
  for (const role of roles) {
    await d.collection("admin_roles").doc(role.id).set({ name: role.name, updated_at: nowTs() }, { merge: true });
  }
  for (const code of ALL_ADMIN_PERMISSION_CODES) {
    await d.collection("admin_permissions").doc(code).set({ code, updated_at: nowTs() }, { merge: true });
    await d.collection("admin_role_permissions").doc(`super_admin__${code}`).set({
      role_id: "super_admin",
      permission_id: code,
    }, { merge: true });
  }
  const support = ["users.view", "verification.review", "consent.review", "reports.view"];
  for (const code of support) {
    await d.collection("admin_role_permissions").doc(`support_admin__${code}`).set({
      role_id: "support_admin",
      permission_id: code,
    }, { merge: true });
  }
  const audit = ["audit.view", "ai.view", "security.view"];
  for (const code of audit) {
    await d.collection("admin_role_permissions").doc(`auditor__${code}`).set({
      role_id: "auditor",
      permission_id: code,
    }, { merge: true });
  }
  return true;
}

export async function adminSetUserRole(d: Db, actor: SessionUser, p: { uid: string; role: string }) {
  if ((await adminRoleOf(d, actor.uid)) !== "super_admin") throw new RpcError("PERMISSION_DENIED", 403);
  const auth = (await import("firebase-admin/auth")).getAuth();
  if (p.role === "none") {
    await d.collection("admin_role_assignments").doc(p.uid).delete();
    await auth.setCustomUserClaims(p.uid, { admin: false });
    await logAudit(d, actor.uid, "admin_role_removed", "user", p.uid, "");
    return true;
  }
  const roleDoc = await d.collection("admin_roles").doc(p.role).get();
  if (!roleDoc.exists) throw new RpcError("ROLE_INVALID", 400);
  await d.collection("admin_role_assignments").doc(p.uid).set({
    role_id: p.role,
    assigned_by: actor.uid,
    created_at: nowTs(),
  });
  await auth.setCustomUserClaims(p.uid, { admin: true, role: p.role });
  await logAudit(d, actor.uid, "admin_role_assigned", "user", p.uid, p.role);
  return true;
}

export async function adminSetUserDisabled(d: Db, actor: SessionUser, p: { uid: string; disabled: boolean }) {
  if ((await adminRoleOf(d, actor.uid)) !== "super_admin") throw new RpcError("PERMISSION_DENIED", 403);
  const auth = (await import("firebase-admin/auth")).getAuth();
  await auth.updateUser(p.uid, { disabled: p.disabled });
  if (p.disabled) await auth.revokeRefreshTokens(p.uid);
  await logAudit(d, actor.uid, p.disabled ? "user_disabled" : "user_enabled", "user", p.uid, "");
  return true;
}

export async function upsertCourse(
  d: Db,
  user: SessionUser,
  p: {
    id?: string;
    title: string;
    slug: string;
    description?: string;
    level?: string;
    duration_minutes?: number;
    icon?: string;
    status?: string;
    modules?: {
      title: string;
      description?: string;
      lessons?: { title: string; summary?: string; body?: string }[];
      quiz?: { title: string; pass_percent?: number; questions?: { question: string; options: string[]; correct_index: number; explanation?: string }[] };
    }[];
  },
) {
  if (!(await hasPermission(d, user.uid, "content.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
  const slug = p.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) throw new RpcError("SLUG_INVALID");
  const payload = {
    title: p.title.trim().slice(0, 160),
    slug,
    description: (p.description ?? "").slice(0, 2000),
    level: p.level ?? "beginner",
    duration_minutes: Number(p.duration_minutes ?? 30),
    icon: p.icon ?? "book",
    status: p.status === "published" || p.status === "archived" ? p.status : "draft",
    updated_at: nowTs(),
  };
  let courseId = p.id;
  if (courseId) {
    await d.collection("courses").doc(courseId).set(payload, { merge: true });
  } else {
    const created = await d.collection("courses").add({ ...payload, sort_order: Date.now() % 10_000, created_at: nowTs() });
    courseId = created.id;
  }
  if (p.modules?.length) {
    for (const [mi, mod] of p.modules.entries()) {
      const moduleDoc = await d.collection("course_modules").add({
        course_id: courseId,
        title: mod.title.slice(0, 160),
        description: (mod.description ?? "").slice(0, 800),
        sort_order: mi,
        created_at: nowTs(),
        updated_at: nowTs(),
      });
      for (const [li, lesson] of (mod.lessons ?? []).entries()) {
        await d.collection("lessons").add({
          module_id: moduleDoc.id,
          title: lesson.title.slice(0, 160),
          summary: (lesson.summary ?? "").slice(0, 400),
          body: (lesson.body ?? "").slice(0, 20_000),
          sort_order: li,
          created_at: nowTs(),
          updated_at: nowTs(),
        });
      }
      if (mod.quiz) {
        const quizDoc = await d.collection("quizzes").add({
          module_id: moduleDoc.id,
          title: mod.quiz.title.slice(0, 160),
          pass_percent: Number(mod.quiz.pass_percent ?? 60),
          sort_order: 0,
          created_at: nowTs(),
          updated_at: nowTs(),
        });
        for (const [qi, q] of (mod.quiz.questions ?? []).entries()) {
          const options = q.options.slice(0, 6).map((text, idx) => ({ id: `opt_${qi}_${idx}`, option_text: text.slice(0, 400) }));
          const question = await d.collection("quiz_questions").add({
            quiz_id: quizDoc.id,
            question: q.question.slice(0, 800),
            explanation: (q.explanation ?? "").slice(0, 800),
            options,
            sort_order: qi,
          });
          const correct = options[q.correct_index]?.id ?? options[0]?.id ?? null;
          await d.collection("quiz_answers").doc(question.id).set({ correct_option_id: correct });
        }
      }
    }
  }
  await logAudit(d, user.uid, "course_upserted", "courses", courseId, payload.title);
  return { id: courseId, slug };
}

export async function getAdminCourse(d: Db, user: SessionUser, courseId: string) {
  if (!(await hasPermission(d, user.uid, "content.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
  const course = await d.collection("courses").doc(courseId).get();
  if (!course.exists) throw new RpcError("NOT_FOUND", 404);
  const modules = await d.collection("course_modules").where("course_id", "==", courseId).get();
  return {
    id: course.id,
    ...course.data(),
    modules: modules.docs.map((m) => ({ id: m.id, title: m.data().title, description: m.data().description ?? "" })),
  };
}

// ---------------------------------------------------------------------------
// 5. IDENTITY / CONSENT REVIEW (admin, RBAC-gated)
// ---------------------------------------------------------------------------
export async function reviewIdentityVerification(
  d: Db,
  reviewer: SessionUser,
  p: { verification_id: string; approve: boolean; reason?: string },
) {
  if (!(await hasPermission(d, reviewer.uid, "verification.review"))) throw new RpcError("PERMISSION_DENIED", 403);
  const ref = d.collection("identity_verifications").doc(p.verification_id);
  const doc = await ref.get();
  if (!doc.exists) throw new RpcError("NOT_FOUND", 404);
  const target = doc.data()!.user_id as string;

  if (p.approve) {
    await ref.set(
      { verification_status: "approved", reviewer_id: reviewer.uid, verified_at: nowTs(), updated_at: nowTs() },
      { merge: true },
    );
    await d.collection("profiles").doc(target).set({ age_verified: true, age_verified_at: nowTs() }, { merge: true });
    await d.collection("notifications").add({
      user_id: target,
      type: "security",
      title: "Identity verified",
      body: "Your age verification was approved. Welcome to MATRIX AI!",
      link: "",
      read_at: null,
      created_at: nowTs(),
    });
    await d.collection("security_events").add({
      user_id: target,
      event_type: "identity_verified",
      metadata: { by: reviewer.uid },
      ip_hash: "",
      created_at: nowTs(),
    });
  } else {
    await ref.set(
      { verification_status: "rejected", reviewer_id: reviewer.uid, rejection_reason: p.reason ?? "", updated_at: nowTs() },
      { merge: true },
    );
    await d.collection("notifications").add({
      user_id: target,
      type: "security",
      title: "Identity verification needs attention",
      body: "Please re-submit your date of birth and birth certificate number.",
      link: "",
      read_at: null,
      created_at: nowTs(),
    });
  }
  await logAudit(d, reviewer.uid, `identity_verification_${p.approve ? "approved" : "rejected"}`, "identity_verifications", p.verification_id, p.reason ?? "");
  return true;
}

export async function reviewGuardianConsent(
  d: Db,
  reviewer: SessionUser,
  p: { user_id: string; approve: boolean; reason?: string },
) {
  if (!(await hasPermission(d, reviewer.uid, "consent.review"))) throw new RpcError("PERMISSION_DENIED", 403);
  const ref = d.collection("guardian_consents").doc(p.user_id);
  if (!(await ref.get()).exists) throw new RpcError("NOT_FOUND", 404);
  if (p.approve) {
    await ref.set({ status: "approved", consented_at: nowTs(), updated_at: nowTs() }, { merge: true });
    await d.collection("security_events").add({
      user_id: p.user_id,
      event_type: "consent_approved",
      metadata: { by: reviewer.uid },
      ip_hash: "",
      created_at: nowTs(),
    });
    await d.collection("notifications").add({
      user_id: p.user_id,
      type: "security",
      title: "Guardian consent approved",
      body: "A guardian approved your MATRIX AI account. Happy learning!",
      link: "",
      read_at: null,
      created_at: nowTs(),
    });
  } else {
    await ref.set({ status: "revoked", revoked_at: nowTs(), updated_at: nowTs() }, { merge: true });
  }
  await logAudit(d, reviewer.uid, `guardian_consent_${p.approve ? "approved" : "revoked"}`, "guardian_consents", p.user_id, p.reason ?? "");
  return true;
}

// ---------------------------------------------------------------------------
// 6. SECURITY EVENTS & SESSIONS
// ---------------------------------------------------------------------------
const EMPTY_SNAP = {
  docs: [] as FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[],
  size: 0,
  empty: true,
};

const CLIENT_EVENT_TYPES = new Set([
  "login", "logout", "password_changed", "password_reset", "email_changed",
  "mfa_enabled", "mfa_disabled", "new_device", "suspicious_activity",
]);

export async function recordSecurityEvent(d: Db, user: SessionUser, eventType: string, metadata: Record<string, unknown> = {}) {
  if (!CLIENT_EVENT_TYPES.has(eventType)) throw new RpcError("EVENT_TYPE_FORBIDDEN");
  await d.collection("security_events").add({
    user_id: user.uid,
    event_type: eventType,
    metadata,
    ip_hash: "",
    created_at: nowTs(),
  });
  return true;
}

export async function revokeSession(d: Db, user: SessionUser, sessionId: string) {
  const ref = d.collection("user_sessions").doc(sessionId);
  const doc = await ref.get();
  if (!doc.exists || doc.data()!.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  await ref.set({ revoked_at: nowTs() }, { merge: true });
  return true;
}

// ---------------------------------------------------------------------------
// 7. ADMIN RBAC
// ---------------------------------------------------------------------------
export async function isAdmin(d: Db, uid: string): Promise<boolean> {
  const assignment = await d.collection("admin_role_assignments").doc(uid).get();
  return assignment.exists;
}

/**
 * Permission codes for the signed-in admin. Super admins always receive the
 * full matrix so a missing seed (empty `admin_role_permissions`) cannot blank
 * or redirect the panel. Never throws — Firestore failures log and return [].
 */
export async function listAdminPermissionCodes(d: Db, uid: string): Promise<string[]> {
  try {
    const assignment = await d.collection("admin_role_assignments").doc(uid).get();
    if (!assignment.exists) return [];
    const roleId = String(assignment.data()?.role_id ?? "");
    if (!roleId) return [];
    if (roleId === "super_admin") return [...ALL_ADMIN_PERMISSION_CODES];
    const links = await d.collection("admin_role_permissions").where("role_id", "==", roleId).get();
    const codes = links.docs
      .map((link) => {
        const fromField = String(link.data()?.permission_id ?? "").trim();
        if (fromField) return fromField;
        const parts = link.id.split("__");
        return parts.length > 1 ? parts.slice(1).join("__") : "";
      })
      .filter(Boolean)
      .map(normalizeAdminPermission);
    return [...new Set(codes)];
  } catch (err) {
    console.error("[MATRIX] listAdminPermissionCodes failed", err);
    return [];
  }
}

export async function hasPermission(d: Db, uid: string, permission: string): Promise<boolean> {
  const assignment = await d.collection("admin_role_assignments").doc(uid).get();
  if (!assignment.exists) return false;
  const roleId = String(assignment.data()?.role_id ?? "");
  if (roleId === "super_admin") return true;
  const needed = normalizeAdminPermission(permission);
  const codes = await listAdminPermissionCodes(d, uid);
  return codes.includes(needed);
}

export async function logAudit(
  d: Db,
  actorId: string,
  action: string,
  targetType = "",
  targetId = "",
  reason = "",
  metadata: Record<string, unknown> = {},
) {
  await d.collection("audit_logs").add({
    actor_id: actorId,
    action,
    target_type: targetType,
    target_id: targetId,
    reason,
    metadata,
    created_at: nowTs(),
  });
  return true;
}

export async function adminListUsers(d: Db, requester: SessionUser) {
  if (!(await hasPermission(d, requester.uid, "users.view"))) throw new RpcError("PERMISSION_DENIED", 403);
  const auth = (await import("firebase-admin/auth")).getAuth();
  const [profiles, consents, verifications, listed] = await Promise.all([
    d.collection("profiles").limit(500).get(),
    d.collection("guardian_consents").get(),
    d.collection("identity_verifications").get(),
    auth.listUsers(500).catch(() => ({ users: [] as import("firebase-admin/auth").UserRecord[] })),
  ]);
  const consentByUser = new Map(consents.docs.map((c) => [c.id, c.data().status as string]));
  const latestVerification = new Map<string, string>();
  const verificationSorted = [...verifications.docs].sort(descDoc("created_at"));
  for (const v of verificationSorted) {
    const uid = v.data().user_id as string;
    if (!latestVerification.has(uid)) latestVerification.set(uid, v.data().verification_status as string);
  }
  const lastSignInByUid = new Map(
    listed.users.map((u) => [u.uid, u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime) : null]),
  );
  const users = profiles.docs
    .slice()
    .sort(descDoc("created_at"))
    .map((p) => {
      const data = p.data();
      const lastSignIn = lastSignInByUid.get(p.id) ?? null;
      return {
        id: p.id,
        email: data.email ?? "",
        full_name: data.full_name ?? "",
        created_at: data.created_at?.toDate?.().toISOString() ?? "",
        last_sign_in_at: lastSignIn && !Number.isNaN(lastSignIn.getTime()) ? lastSignIn.toISOString() : null,
        age_verified: data.age_verified ?? false,
        country: data.country ?? "",
        consent_status: consentByUser.get(p.id) ?? "none",
        identity_status: latestVerification.get(p.id) ?? "none",
      };
    });
  return users;
}

// ---------------------------------------------------------------------------
// 8. PRIVILEGED DATA ACCESS (admin → user conversations, time-limited + audited)
// ---------------------------------------------------------------------------
export async function requestAdminAccess(
  d: Db,
  requester: SessionUser,
  p: { target_user_id: string; scope?: string; reason: string; duration_hours?: number },
) {
  if (!(await hasPermission(d, requester.uid, "privacy.access"))) throw new RpcError("PERMISSION_DENIED", 403);
  const hours = p.duration_hours ?? 24;
  if (hours < 1 || hours > 168) throw new RpcError("DURATION_INVALID");
  const reason = p.reason.trim();
  if (!reason) throw new RpcError("REASON_REQUIRED");
  const grant = await d.collection("admin_access_grants").add({
    requester_id: requester.uid,
    target_user_id: p.target_user_id,
    scope: p.scope ?? "conversations",
    reason,
    status: "active",
    expires_at: toTs(new Date(Date.now() + hours * 3600_000)),
    created_at: nowTs(),
  });
  await logAudit(d, requester.uid, "admin_access_requested", "user", p.target_user_id, reason, {
    grant_id: grant.id,
    scope: p.scope ?? "conversations",
  });
  return grant.id;
}

async function activeGrant(d: Db, grantId: string) {
  const doc = await d.collection("admin_access_grants").doc(grantId).get();
  if (!doc.exists) throw new RpcError("GRANT_INVALID_OR_EXPIRED", 404);
  const data = doc.data()!;
  const expired = data.expires_at?.toDate?.()?.getTime?.() ?? 0 < Date.now();
  if (data.status !== "active" || expired) throw new RpcError("GRANT_INVALID_OR_EXPIRED", 404);
  return data;
}

export async function adminListConversations(d: Db, requester: SessionUser, grantId: string) {
  if (!(await hasPermission(d, requester.uid, "privacy.access"))) throw new RpcError("PERMISSION_DENIED", 403);
  const grant = await activeGrant(d, grantId);
  const snap = await d.collection("conversations").where("user_id", "==", grant.target_user_id).get();
  return snap.docs
    .filter((c) => c.data().deleted_at == null)
    .sort(descDoc("updated_at"))
    .slice(0, 100)
    .map((c) => ({
    id: c.id,
    title: c.data().title ?? "",
    created_at: c.data().created_at?.toDate?.().toISOString() ?? "",
    updated_at: c.data().updated_at?.toDate?.().toISOString() ?? "",
    is_temporary: c.data().is_temporary ?? false,
  }));
}

export async function adminViewConversation(d: Db, requester: SessionUser, grantId: string, conversationId: string) {
  if (!(await hasPermission(d, requester.uid, "privacy.access"))) throw new RpcError("PERMISSION_DENIED", 403);
  const grant = await activeGrant(d, grantId);
  const conv = await d.collection("conversations").doc(conversationId).get();
  if (!conv.exists) throw new RpcError("NOT_FOUND", 404);
  const messages = await conv.ref.collection("messages").orderBy("created_at", "asc").get();
  await logAudit(d, requester.uid, "admin_conversation_viewed", "conversation", conversationId, grant.reason ?? "", { grant_id: grantId });
  return messages.docs.map((m) => ({
    role: m.data().role,
    content: m.data().content,
    created_at: m.data().created_at?.toDate?.().toISOString() ?? "",
  }));
}

// ---------------------------------------------------------------------------
// 9. LEARNING
// ---------------------------------------------------------------------------
async function publishedLesson(d: Db, lessonId: string) {
  const lesson = await d.collection("lessons").doc(lessonId).get();
  if (!lesson.exists) return null;
  const moduleId = lesson.data()!.module_id as string;
  const mod = await d.collection("course_modules").doc(moduleId).get();
  if (!mod.exists) return null;
  const course = await d.collection("courses").doc(mod.data()!.course_id as string).get();
  if (!course.exists || course.data()!.status !== "published") return null;
  return lesson;
}

export async function updateCourseProgress(d: Db, user: SessionUser, lessonId: string, status: string) {
  if (!["started", "completed"].includes(status)) throw new RpcError("STATUS_INVALID");
  const lesson = await publishedLesson(d, lessonId);
  if (!lesson) throw new RpcError("LESSON_NOT_FOUND", 404);
  const ref = d.collection("course_progress").doc(`${user.uid}_${lessonId}`);
  const existing = await ref.get();
  const alreadyCompleted = existing.exists && existing.data()?.status === "completed";
  await ref.set(
    {
      user_id: user.uid,
      lesson_id: lessonId,
      status: alreadyCompleted ? "completed" : status,
      progress: status === "completed" || alreadyCompleted ? 100 : Math.max(existing.data()?.progress ?? 0, 10),
      completed_at: status === "completed" || alreadyCompleted ? existing.data()?.completed_at ?? nowTs() : null,
      updated_at: nowTs(),
    },
    { merge: true },
  );
  return { ok: true };
}

export async function submitQuizAttempt(d: Db, user: SessionUser, quizId: string, answers: { question_id: string; option_id: string | null }[]) {
  const quiz = await d.collection("quizzes").doc(quizId).get();
  if (!quiz.exists) throw new RpcError("QUIZ_NOT_FOUND", 404);
  const maxAttempts = quiz.data()!.max_attempts ?? 0;
  if (maxAttempts > 0) {
    const attempts = await d.collection("quiz_attempts").where("user_id", "==", user.uid).where("quiz_id", "==", quizId).get();
    if (attempts.size >= maxAttempts) throw new RpcError("ATTEMPT_LIMIT_REACHED", 429);
  }
  // Equality-only fetch (no composite index required); the original query
  // ordered by sort_order but only empty/size are consumed below.
  const questions = await d.collection("quiz_questions").where("quiz_id", "==", quizId).get();
  if (questions.empty) throw new RpcError("QUIZ_EMPTY");
  const total = questions.size;

  const results = [] as Record<string, unknown>[];
  let correct = 0;
  for (const a of answers.slice(0, 100)) {
    const answerDoc = await d.collection("quiz_answers").doc(a.question_id).get();
    const correctOptionId: string | null = answerDoc.exists ? (answerDoc.data()!.correct_option_id ?? null) : null;
    const isCorrect = Boolean(correctOptionId) && correctOptionId === a.option_id;
    if (isCorrect) correct++;
    results.push({
      question_id: a.question_id,
      selected_option_id: a.option_id,
      correct_option_id: correctOptionId,
      correct: isCorrect,
    });
  }
  const percent = Math.round((correct / total) * 10000) / 100;
  const passed = percent >= (quiz.data()!.pass_percent ?? 60);
  const attempt = await d.collection("quiz_attempts").add({
    user_id: user.uid,
    quiz_id: quizId,
    score_percent: percent,
    passed,
    answers: results,
    started_at: nowTs(),
    completed_at: nowTs(),
  });
  return { attempt_id: attempt.id, score_percent: percent, passed, correct, total, results };
}

export async function checkCertificateEligibility(d: Db, userId: string, courseId: string): Promise<{ eligible: boolean; reason: string }> {
  const course = await d.collection("courses").doc(courseId).get();
  if (!course.exists || course.data()!.status !== "published") return { eligible: false, reason: "Course not found or not published" };
  const modules = await d.collection("course_modules").where("course_id", "==", courseId).get();
  const moduleIds = modules.docs.map((m) => m.id);
  const lessons = moduleIds.length
    ? await d.collection("lessons").where("module_id", "in", moduleIds.slice(0, 10)).get()
    : EMPTY_SNAP;
  const lessonIds = lessons.docs.map((l) => l.id);
  const done = lessonIds.length
    ? await d.collection("course_progress").where("user_id", "==", userId).where("lesson_id", "in", lessonIds.slice(0, 10)).get()
    : EMPTY_SNAP;
  const doneCount = done.docs.filter((p) => p.data().status === "completed").length;
  if (doneCount < lessonIds.length) return { eligible: false, reason: `Complete all lessons (${doneCount} of ${lessonIds.length} done)` };

  const quizzes = moduleIds.length
    ? await d.collection("quizzes").where("module_id", "in", moduleIds.slice(0, 10)).get()
    : EMPTY_SNAP;
  if (quizzes.size > 0) {
    const quizIds = quizzes.docs.map((q) => q.id);
    const attempts = await d.collection("quiz_attempts").where("user_id", "==", userId).where("quiz_id", "in", quizIds.slice(0, 10)).get();
    const passedSet = new Set<string>();
    for (const a of attempts.docs) if (a.data().passed) passedSet.add(a.data().quiz_id as string);
    if (passedSet.size < quizzes.size) return { eligible: false, reason: `Pass every quiz (${passedSet.size} of ${quizzes.size} passed)` };
  }
  const cert = await d.collection("certificates").doc(`${userId}_${courseId}`).get();
  if (cert.exists) return { eligible: false, reason: "Certificate already issued for this course" };
  return { eligible: true, reason: "Eligible" };
}

export async function issueCertificate(d: Db, user: SessionUser, courseId: string) {
  const eligibility = await checkCertificateEligibility(d, user.uid, courseId);
  if (!eligibility.eligible) throw new RpcError(`NOT_ELIGIBLE: ${eligibility.reason}`, 403);
  const suffix = crypto.randomBytes(6).toString("hex").slice(0, 8).toUpperCase();
  const certificateId = `MATRIX-${new Date().getFullYear()}-${suffix}`;
  const course = await d.collection("courses").doc(courseId).get();
  await d.collection("certificates").doc(`${user.uid}_${courseId}`).set({
    user_id: user.uid,
    course_id: courseId,
    certificate_id: certificateId,
    issued_at: nowTs(),
    verification_status: "valid",
    revoked_at: null,
    created_at: nowTs(),
  });
  await d.collection("notifications").add({
    user_id: user.uid,
    type: "certificate",
    title: "Certificate earned!",
    body: `You completed "${course.data()?.title ?? "the course"}" and earned a certificate.`,
    link: "/certificate",
    read_at: null,
    created_at: nowTs(),
  });
  return { certificate_id: certificateId, course: course.data()?.title ?? "" };
}

/** Public verification — returns ONLY public-safe fields. */
export async function verifyCertificateLookup(d: Db, certificateId: string) {
  const snap = await d.collection("certificates").where("certificate_id", "==", certificateId).limit(1).get();
  if (snap.empty) return { valid: false, certificate_id: certificateId };
  const cert = snap.docs[0];
  const [course, profile] = await Promise.all([
    d.collection("courses").doc(cert.data().course_id as string).get(),
    d.collection("profiles").doc(cert.data().user_id as string).get(),
  ]);
  await d.collection("certificate_verification").add({
    certificate_id: certificateId,
    verified_at: nowTs(),
    ip_hash: "",
  });
  return {
    valid: true,
    certificate_id: certificateId,
    course: course.data()?.title ?? "",
    display_name: profile.data()?.full_name ?? "",
    issued_at: cert.data().issued_at?.toDate?.().toISOString() ?? "",
    issued_by: "MATRIX AI — THAMJJ13.TOP White Hat Team",
    verification_status: cert.data().verification_status ?? "valid",
  };
}

// ---------------------------------------------------------------------------
// 10. RAG (ported from tsvector search to token-overlap scoring)
// ---------------------------------------------------------------------------
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09FF\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export type RagChunk = { title: string; content: string; source_type: string; trust_level: string };

export async function ragSearch(d: Db, query: string, limit = 5): Promise<RagChunk[]> {
  const terms = tokenize(query.slice(0, 200));
  if (terms.length === 0) return [];
  const [chunks, articles, lessons, resources] = await Promise.all([
    d.collection("document_chunks").where("trust_level", "in", ["trusted_official", "trusted_internal"]).limit(300).get(),
    d.collection("scam_articles").where("status", "==", "active").limit(300).get(),
    d.collection("lessons").limit(500).get(),
    d.collection("reporting_resources").where("status", "==", "active").limit(200).get(),
  ]);

  const scored: { chunk: RagChunk; score: number }[] = [];
  const score = (title: string, body: string, chunk: RagChunk) => {
    const haystack = tokenize(`${title} ${body}`);
    const set = new Set(haystack);
    let s = 0;
    for (const t of terms) if (set.has(t)) s += 1;
    if (s > 0) scored.push({ chunk, score: s + (title.toLowerCase().includes(terms[0]) ? 0.5 : 0) });
  };

  for (const c of chunks.docs) score(c.data().title ?? "", c.data().content ?? "", {
    title: c.data().title, content: c.data().content, source_type: c.data().source_type ?? "knowledge", trust_level: c.data().trust_level ?? "trusted_internal",
  });
  for (const a of articles.docs) {
    const data = a.data();
    const body = `${data.description ?? ""} ${data.warning_signs ?? ""} ${data.prevention ?? ""}`;
    score(data.title ?? "", body, { title: data.title, content: body, source_type: "scam_article", trust_level: data.trust_level ?? "trusted_internal" });
  }
  for (const l of lessons.docs) score(l.data().title ?? "", l.data().body ?? "", {
    title: l.data().title, content: l.data().body, source_type: "lesson", trust_level: "trusted_internal",
  });
  for (const r of resources.docs) {
    const data = r.data();
    const body = `${data.description ?? ""} ${data.official_url ?? ""}`;
    score(data.organization ?? "", body, { title: data.organization, content: body, source_type: "reporting_resource", trust_level: "trusted_official" });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.chunk);
}

// ---------------------------------------------------------------------------
// 11. SECURITY SCORE (server-side; the UI only displays the result)
// ---------------------------------------------------------------------------
export async function securityScore(d: Db, user: SessionUser): Promise<number> {
  let score = 40;
  try {
    const auth = (await import("firebase-admin/auth")).getAuth();
    const record = await auth.getUser(user.uid);
    const totp = (record.multiFactor?.enrolledFactors ?? []).some((f) => f.factorId === "totp");
    if (totp) score += 20;
    if (record.emailVerified) score += 10;
  } catch {
    /* auth record unavailable — skip email/mfa bonuses */
  }
  const [profile, progress, certs] = await Promise.all([
    d.collection("profiles").doc(user.uid).get(),
    d.collection("course_progress").where("user_id", "==", user.uid).where("status", "==", "completed").get(),
    d.collection("certificates").where("user_id", "==", user.uid).get(),
  ]);
  if (profile.data()?.age_verified) score += 10;
  score += Math.min(10, progress.size);
  score += Math.min(10, certs.size * 5);
  return Math.min(100, score);
}

// ---------------------------------------------------------------------------
// 12. RETENTION / CLEANUP (port of expire_stale — run via scripts or lazily)
// ---------------------------------------------------------------------------
export async function expireStale(d: Db): Promise<number> {
  const day = 24 * 3600_000;
  let deleted = 0;
  const oldTemp = await d
    .collection("conversations")
    .where("is_temporary", "==", true)
    .where("created_at", "<", toTs(new Date(Date.now() - day)))
    .limit(200).get();
  for (const c of oldTemp.docs) {
    await c.ref.delete();
    deleted++;
  }
  const oldDeleted = await d
    .collection("conversations")
    .where("deleted_at", "<", toTs(new Date(Date.now() - 90 * day)))
    .limit(200).get();
  for (const c of oldDeleted.docs) {
    await c.ref.delete();
    deleted++;
  }
  const oldConsents = await d
    .collection("guardian_consents")
    .where("status", "==", "pending")
    .where("created_at", "<", toTs(new Date(Date.now() - 30 * day)))
    .limit(200).get();
  for (const c of oldConsents.docs) await c.ref.set({ status: "expired", updated_at: nowTs() }, { merge: true });
  const oldGrants = await d
    .collection("admin_access_grants")
    .where("status", "==", "active")
    .where("expires_at", "<", nowTs())
    .limit(200).get();
  for (const g of oldGrants.docs) await g.ref.set({ status: "expired" }, { merge: true });
  return deleted;
}
