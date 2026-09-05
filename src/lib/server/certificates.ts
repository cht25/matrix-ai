// =============================================================================
// MATRIX certificates — issuance, persistence and lookup.
//
// A certificate is issued ONCE per (user, course) pair and keeps a stable,
// human-readable, sequential public ID:
//
//     MTRX-CERT-2026-000123
//
// The sequence lives in `counters/certificates` and is incremented inside a
// Firestore transaction, so two concurrent claims can never receive the same
// number and a page refresh never mints a new ID. Issuance itself is
// idempotent: claiming an already-issued certificate returns the stored one.
// =============================================================================

import "server-only";
import { Db, nowTs } from "@/lib/firebase/admin";
import { RpcError } from "@/lib/server/errors";

export const CERT_ISSUER = "MATRIX — THAMJJ13.TOP White Hat Team";

export type StoredCertificate = {
  certificate_id: string;
  user_id: string;
  course_id: string;
  course_title: string;
  display_name: string;
  score_percent: number;
  issued_at: string;
  verification_status: string;
};

/** Public-safe projection used by the verification page, print view and PDF. */
export type PublicCertificate = {
  valid: boolean;
  certificate_id: string;
  course: string;
  display_name: string;
  score_percent: number;
  issued_at: string;
  issued_by: string;
  verification_status: string;
};

function docId(userId: string, courseId: string) {
  return `${userId}_${courseId}`;
}

function isoOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const ts = value as { toDate?: () => Date };
  return typeof ts.toDate === "function" ? ts.toDate().toISOString() : "";
}

/**
 * Reserve the next certificate number for the given year.
 * Transactional — concurrent claims are serialised by Firestore.
 */
export async function nextCertificateId(d: Db, year = new Date().getFullYear()): Promise<string> {
  const ref = d.collection("counters").doc("certificates");
  const seq = await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.exists ? snap.data() : {}) ?? {};
    const perYear = (data.per_year as Record<string, number> | undefined) ?? {};
    const next = (typeof perYear[String(year)] === "number" ? perYear[String(year)] : 0) + 1;
    tx.set(ref, { per_year: { ...perYear, [String(year)]: next }, updated_at: nowTs() }, { merge: true });
    return next;
  });
  return formatCertificateId(year, seq);
}

/** `MTRX-CERT-2026-000123` — zero-padded to six digits, wider when needed. */
export function formatCertificateId(year: number, sequence: number): string {
  return `MTRX-CERT-${year}-${String(sequence).padStart(6, "0")}`;
}

/** True for anything shaped like a MATRIX certificate ID (incl. legacy IDs). */
export function isCertificateIdShape(value: string): boolean {
  return /^(MTRX-CERT|MATRIX)-[A-Z0-9-]{4,40}$/i.test(value.trim());
}

/**
 * The score that earned the certificate: the user's best passing attempt
 * across the course's quizzes. Real data — never a hard-coded 100%.
 */
export async function bestScoreForCourse(d: Db, userId: string, courseId: string): Promise<number> {
  const modules = await d.collection("course_modules").where("course_id", "==", courseId).get();
  const moduleIds = modules.docs.map((m) => m.id).slice(0, 10);
  if (!moduleIds.length) return 0;
  const quizzes = await d.collection("quizzes").where("module_id", "in", moduleIds).get();
  const quizIds = quizzes.docs.map((q) => q.id).slice(0, 10);
  if (!quizIds.length) return 0;
  const attempts = await d.collection("quiz_attempts").where("user_id", "==", userId).where("quiz_id", "in", quizIds).get();
  // Average of the best score per quiz — matches how completion is judged.
  const best = new Map<string, number>();
  for (const a of attempts.docs) {
    const quizId = a.data().quiz_id as string;
    const score = Number(a.data().score_percent ?? 0);
    if (!best.has(quizId) || score > (best.get(quizId) as number)) best.set(quizId, score);
  }
  if (best.size === 0) return 0;
  const total = [...best.values()].reduce((sum, v) => sum + v, 0);
  return Math.round(total / best.size);
}

/** Read the certificate a user already holds for a course, if any. */
export async function readCertificate(d: Db, userId: string, courseId: string): Promise<StoredCertificate | null> {
  const snap = await d.collection("certificates").doc(docId(userId, courseId)).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  return {
    certificate_id: String(data.certificate_id ?? ""),
    user_id: userId,
    course_id: courseId,
    course_title: String(data.course_title ?? ""),
    display_name: String(data.display_name ?? ""),
    score_percent: Number(data.score_percent ?? 0),
    issued_at: isoOf(data.issued_at),
    verification_status: String(data.verification_status ?? "valid"),
  };
}

/**
 * Look a certificate up by its public ID and return ONLY public-safe fields.
 * Used by /certificate/verify/[id], the print view and the PDF endpoint.
 */
export async function lookupCertificate(d: Db, certificateId: string): Promise<PublicCertificate> {
  const id = certificateId.trim();
  const notFound: PublicCertificate = {
    valid: false,
    certificate_id: id,
    course: "",
    display_name: "",
    score_percent: 0,
    issued_at: "",
    issued_by: CERT_ISSUER,
    verification_status: "not_found",
  };
  if (!id || id.length > 64) return notFound;

  const snap = await d.collection("certificates").where("certificate_id", "==", id).limit(1).get();
  if (snap.empty) return notFound;
  const cert = snap.docs[0];
  const data = cert.data();

  // Denormalised course title / name are written at issuance; fall back to a
  // live read for certificates issued before that field existed.
  let course = String(data.course_title ?? "");
  let displayName = String(data.display_name ?? "");
  if (!course || !displayName) {
    const [courseDoc, profile] = await Promise.all([
      d.collection("courses").doc(String(data.course_id)).get(),
      d.collection("profiles").doc(String(data.user_id)).get(),
    ]);
    course = course || String(courseDoc.data()?.title ?? "");
    displayName = displayName || String(profile.data()?.full_name ?? "");
  }

  return {
    valid: String(data.verification_status ?? "valid") === "valid",
    certificate_id: id,
    course,
    display_name: displayName,
    score_percent: Number(data.score_percent ?? 0),
    issued_at: isoOf(data.issued_at),
    issued_by: CERT_ISSUER,
    verification_status: String(data.verification_status ?? "valid"),
  };
}

/** Record a verification hit (no IP, no personal data). */
export async function recordVerification(d: Db, certificateId: string): Promise<void> {
  await d
    .collection("certificate_verification")
    .add({ certificate_id: certificateId, verified_at: nowTs() })
    .catch(() => undefined);
}

/**
 * Issue (or return the existing) certificate for a course.
 * `checkEligibility` is injected so this module stays free of the large rpc
 * module and remains unit-testable.
 */
export async function issueCertificateFor(
  d: Db,
  params: { userId: string; courseId: string },
  checkEligibility: (userId: string, courseId: string) => Promise<{ eligible: boolean; reason: string }>,
): Promise<StoredCertificate & { already_issued: boolean }> {
  const { userId, courseId } = params;

  // Already claimed? Return the persisted certificate — same ID, every time.
  const existing = await readCertificate(d, userId, courseId);
  if (existing && existing.certificate_id) return { ...existing, already_issued: true };

  const eligibility = await checkEligibility(userId, courseId);
  if (!eligibility.eligible) throw new RpcError(`NOT_ELIGIBLE: ${eligibility.reason}`, 403);

  const [courseDoc, profile, score] = await Promise.all([
    d.collection("courses").doc(courseId).get(),
    d.collection("profiles").doc(userId).get(),
    bestScoreForCourse(d, userId, courseId),
  ]);
  const courseTitle = String(courseDoc.data()?.title ?? "Course");
  const displayName = String(profile.data()?.full_name ?? "").trim() || "MATRIX learner";

  const certificateId = await nextCertificateId(d);
  const record = {
    user_id: userId,
    course_id: courseId,
    certificate_id: certificateId,
    course_title: courseTitle,
    display_name: displayName,
    score_percent: score,
    issued_at: nowTs(),
    verification_status: "valid",
    revoked_at: null,
    created_at: nowTs(),
  };
  await d.collection("certificates").doc(docId(userId, courseId)).set(record);

  await d
    .collection("notifications")
    .add({
      user_id: userId,
      type: "certificate",
      title: "Certificate issued",
      body: `You completed "${courseTitle}" and earned certificate ${certificateId}.`,
      link: `/certificate/verify/${certificateId}`,
      read_at: null,
      created_at: nowTs(),
    })
    .catch(() => undefined);

  return {
    certificate_id: certificateId,
    user_id: userId,
    course_id: courseId,
    course_title: courseTitle,
    display_name: displayName,
    score_percent: score,
    issued_at: new Date().toISOString(),
    verification_status: "valid",
    already_issued: false,
  };
}
