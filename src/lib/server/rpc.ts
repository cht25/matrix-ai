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

// ---------------------------------------------------------------------------
// Errors (mirror the SQL exception codes)
// ---------------------------------------------------------------------------
export class RpcError extends Error {
  constructor(readonly code: string, readonly status: number = 400) {
    super(code);
    this.name = "RpcError";
  }
}

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
        avatar_url: "",
        created_at: nowTs(),
      },
      { merge: true },
    );
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
    reviewer_id: null,
    rejection_reason: "",
    verified_at: null,
    created_at: nowTs(),
    updated_at: nowTs(),
  });
  return true;
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
      body: "Please re-submit your age verification document.",
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

export async function hasPermission(d: Db, uid: string, permission: string): Promise<boolean> {
  const assignment = await d.collection("admin_role_assignments").doc(uid).get();
  if (!assignment.exists) return false;
  const roleId = assignment.data()!.role_id as string;
  const perms = await d.collection("admin_role_permissions").where("role_id", "==", roleId).get();
  if (perms.empty) return false;
  const permIds = perms.docs.map((p) => p.id.split("__")[1]).filter(Boolean);
  const permDocs = await d.getAll(...permIds.map((id) => d.collection("admin_permissions").doc(id)));
  return permDocs.some((p) => p.exists && p.data()?.code === permission);
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
  const [profiles, consents, verifications] = await Promise.all([
    d.collection("profiles").orderBy("created_at", "desc").limit(500).get(),
    d.collection("guardian_consents").get(),
    d.collection("identity_verifications").orderBy("created_at", "desc").get(),
  ]);
  const consentByUser = new Map(consents.docs.map((c) => [c.id, c.data().status as string]));
  const latestVerification = new Map<string, string>();
  for (const v of verifications.docs) {
    const uid = v.data().user_id as string;
    if (!latestVerification.has(uid)) latestVerification.set(uid, v.data().verification_status as string);
  }
  const users = await Promise.all(
    profiles.docs.map(async (p) => {
      const data = p.data();
      let lastSignIn: Date | null = null;
      try {
        const meta = (await auth.getUser(p.id)).metadata;
        const when = meta.lastSignInTime ? new Date(meta.lastSignInTime) : null;
        lastSignIn = when && !Number.isNaN(when.getTime()) ? when : null;
      } catch {
        /* user deleted in Auth but not Firestore — report null */
      }
      return {
        id: p.id,
        email: data.email ?? "",
        full_name: data.full_name ?? "",
        created_at: data.created_at?.toDate?.().toISOString() ?? "",
        last_sign_in_at: lastSignIn ? lastSignIn.toISOString() : null,
        age_verified: data.age_verified ?? false,
        country: data.country ?? "",
        consent_status: consentByUser.get(p.id) ?? "none",
        identity_status: latestVerification.get(p.id) ?? "none",
      };
    }),
  );
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
  const snap = await d
    .collection("conversations")
    .where("user_id", "==", grant.target_user_id)
    .where("deleted_at", "==", null)
    .orderBy("updated_at", "desc")
    .limit(100)
    .get();
  return snap.docs.map((c) => ({
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
  const questions = await d.collection("quiz_questions").where("quiz_id", "==", quizId).orderBy("sort_order", "asc").get();
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
