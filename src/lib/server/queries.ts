// Server-side read queries for pages (Firebase/Firestore port).
// Shapes intentionally mirror the previous Supabase selects (snake_case
// fields, ISO date strings) so page rendering code stays unchanged.

import "server-only";
import { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { isAdmin, securityScore } from "@/lib/server/rpc";

const iso = (v: unknown): string => {
  const ts = v as { toDate?: () => Date } | null | undefined;
  if (ts?.toDate) return ts.toDate().toISOString();
  return typeof v === "string" ? v : "";
};

// ---------------------------------------------------------------------------
// App shell / sidebar
// ---------------------------------------------------------------------------
export async function getSidebarData(d: Db, uid: string) {
  const [convs, profile, admin] = await Promise.all([
    d.collection("conversations")
      .where("user_id", "==", uid)
      .where("deleted_at", "==", null)
      .where("archived_at", "==", null)
      .orderBy("updated_at", "desc")
      .limit(100)
      .get(),
    d.collection("profiles").doc(uid).get(),
    isAdmin(d, uid),
  ]);
  return {
    conversations: convs.docs.map((c) => {
      const data = c.data();
      return {
        id: c.id,
        title: data.title ?? "New conversation",
        summary: data.summary ?? "",
        updated_at: iso(data.updated_at),
        is_temporary: data.is_temporary ?? false,
        archived_at: data.archived_at ? iso(data.archived_at) : null,
      };
    }),
    profileName: profile.data()?.full_name ?? "",
    isAdmin: admin,
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export async function getDashboardData(d: Db, user: SessionUser) {
  const [score, profile, progress, certs, events, analyses, settings] = await Promise.all([
    securityScore(d, user),
    d.collection("profiles").doc(user.uid).get(),
    d.collection("course_progress").where("user_id", "==", user.uid).where("status", "==", "completed").get(),
    d.collection("certificates").where("user_id", "==", user.uid).orderBy("issued_at", "desc").limit(5).get(),
    d.collection("security_events").where("user_id", "==", user.uid).orderBy("created_at", "desc").limit(5).get(),
    d.collection("security_analyses").where("user_id", "==", user.uid).orderBy("created_at", "desc").limit(3).get(),
    d.collection("user_security_settings").doc(user.uid).get(),
  ]);
  return {
    securityScore: score,
    profile: profile.exists
      ? {
          id: profile.id,
          full_name: profile.data()?.full_name ?? "",
          age_verified: profile.data()?.age_verified ?? false,
          email: profile.data()?.email ?? "",
          created_at: iso(profile.data()?.created_at),
        }
      : null,
    completedLessons: progress.docs.map((p) => ({ status: p.data().status as string })),
    certificates: certs.docs.map((c) => ({ id: c.id, certificate_id: c.data().certificate_id as string, issued_at: iso(c.data().issued_at) })),
    securityEvents: events.docs.map((e) => ({ event_type: e.data().event_type as string, created_at: iso(e.data().created_at) })),
    analyses: analyses.docs.map((a) => ({ risk_level: a.data().risk_level as string, created_at: iso(a.data().created_at) })),
    alertsEnabled: settings.data()?.notifications_security_alerts ?? true,
  };
}

// ---------------------------------------------------------------------------
// Chat / history
// ---------------------------------------------------------------------------
export async function getConversation(d: Db, uid: string, id: string) {
  const ref = d.collection("conversations").doc(id);
  const conv = await ref.get();
  if (!conv.exists || conv.data()!.user_id !== uid) return null;
  const messages = await ref.collection("messages").orderBy("created_at", "asc").get();
  return {
    conversation: { id: conv.id, title: conv.data()!.title ?? "New conversation", is_temporary: conv.data()!.is_temporary ?? false },
    messages: messages.docs.map((m) => ({ id: m.id, role: m.data().role, content: m.data().content, created_at: iso(m.data().created_at) })),
  };
}

export async function getHistory(d: Db, uid: string) {
  const convs = await d
    .collection("conversations")
    .where("user_id", "==", uid)
    .where("is_temporary", "==", false)
    .where("deleted_at", "==", null)
    .orderBy("updated_at", "desc")
    .limit(200)
    .get();
  return convs.docs.map((c) => {
    const data = c.data();
    return {
      id: c.id,
      title: data.title ?? "New conversation",
      summary: data.summary ?? "",
      created_at: iso(data.created_at),
      updated_at: iso(data.updated_at),
      archived_at: data.archived_at ? iso(data.archived_at) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------
export async function getCoursesOverview(d: Db, uid: string) {
  const [courses, modules, lessons, progress, certs] = await Promise.all([
    d.collection("courses").where("status", "==", "published").orderBy("sort_order", "asc").get(),
    d.collection("course_modules").get(),
    d.collection("lessons").orderBy("sort_order", "asc").get(),
    d.collection("course_progress").where("user_id", "==", uid).get(),
    d.collection("certificates").where("user_id", "==", uid).get(),
  ]);
  return {
    courses: courses.docs.map((c) => ({
      id: c.id, slug: c.data().slug, title: c.data().title, description: c.data().description ?? "",
      level: c.data().level ?? "beginner", duration_minutes: c.data().duration_minutes ?? 30, icon: c.data().icon ?? "book",
    })),
    modules: modules.docs.map((m) => ({ id: m.id, course_id: m.data().course_id, title: m.data().title })),
    lessons: lessons.docs.map((l) => ({ id: l.id, module_id: l.data().module_id, title: l.data().title, sort_order: l.data().sort_order ?? 0 })),
    progress: progress.docs.map((p) => ({ lesson_id: p.data().lesson_id, status: p.data().status })),
    certificates: certs.docs.map((c) => ({ course_id: c.data().course_id, certificate_id: c.data().certificate_id })),
  };
}

export type CourseRecord = { id: string; slug: string; title: string; description: string; level: string; duration_minutes: number; icon: string };

export async function getCourseBySlug(d: Db, slug: string): Promise<CourseRecord | null> {
  const snap = await d.collection("courses").where("slug", "==", slug).where("status", "==", "published").limit(1).get();
  if (snap.empty) return null;
  const data = snap.docs[0].data();
  return {
    id: snap.docs[0].id,
    slug: String(data.slug ?? slug),
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    level: String(data.level ?? "beginner"),
    duration_minutes: Number(data.duration_minutes ?? 30),
    icon: String(data.icon ?? "book"),
  };
}

export async function getCourseDetail(d: Db, uid: string, slug: string) {
  const course = await getCourseBySlug(d, slug);
  if (!course) return null;
  const courseId = course.id;
  const [modules, lessons, quizzes, progress, attempts, cert] = await Promise.all([
    d.collection("course_modules").where("course_id", "==", courseId).orderBy("sort_order", "asc").get(),
    d.collection("lessons").orderBy("sort_order", "asc").get(),
    d.collection("quizzes").orderBy("sort_order", "asc").get(),
    d.collection("course_progress").where("user_id", "==", uid).get(),
    d.collection("quiz_attempts").where("user_id", "==", uid).get(),
    d.collection("certificates").doc(`${uid}_${courseId}`).get(),
  ]);
  const moduleIds = new Set(modules.docs.map((m) => m.id));
  return {
    course,
    modules: modules.docs.map((m) => ({ id: m.id, title: m.data().title, description: m.data().description ?? "", sort_order: m.data().sort_order ?? 0 })),
    lessons: lessons.docs.filter((l) => moduleIds.has(l.data().module_id)).map((l) => ({ id: l.id, module_id: l.data().module_id, title: l.data().title, summary: l.data().summary ?? "", sort_order: l.data().sort_order ?? 0 })),
    quizzes: quizzes.docs.filter((q) => moduleIds.has(q.data().module_id)).map((q) => ({ id: q.id, module_id: q.data().module_id, title: q.data().title, pass_percent: q.data().pass_percent ?? 60, sort_order: q.data().sort_order ?? 0 })),
    progress: progress.docs.map((p) => ({ lesson_id: p.data().lesson_id, status: p.data().status })),
    attempts: attempts.docs.map((a) => ({ quiz_id: a.data().quiz_id, passed: a.data().passed, score_percent: a.data().score_percent })),
    certificate: cert.exists ? { certificate_id: cert.data()!.certificate_id as string, issued_at: iso(cert.data()!.issued_at) } : null,
  };
}

export async function getLessonPage(d: Db, uid: string, slug: string, lessonId: string) {
  const course = await getCourseBySlug(d, slug);
  if (!course) return null;
  const [lesson, modules, lessons, progress] = await Promise.all([
    d.collection("lessons").doc(lessonId).get(),
    d.collection("course_modules").where("course_id", "==", course.id as string).orderBy("sort_order", "asc").get(),
    d.collection("lessons").orderBy("sort_order", "asc").get(),
    d.collection("course_progress").doc(`${uid}_${lessonId}`).get(),
  ]);
  if (!lesson.exists) return null;
  return {
    lesson: { id: lesson.id, module_id: String(lesson.data()!.module_id ?? ""), title: String(lesson.data()!.title ?? ""), summary: String(lesson.data()!.summary ?? ""), body: String(lesson.data()!.body ?? ""), sort_order: Number(lesson.data()!.sort_order ?? 0) },
    course: { id: course.id, slug: course.slug, title: course.title },
    modules: modules.docs.map((m) => ({ id: m.id, course_id: m.data().course_id, sort_order: m.data().sort_order ?? 0 })),
    lessons: lessons.docs.map((l) => ({ id: l.id, module_id: l.data().module_id, title: l.data().title, sort_order: l.data().sort_order ?? 0 })),
    progress: progress.exists ? { status: progress.data()!.status as string } : null,
  };
}

export async function getQuizPage(d: Db, slug: string, quizId: string) {
  const course = await getCourseBySlug(d, slug);
  if (!course) return null;
  const quiz = await d.collection("quizzes").doc(quizId).get();
  if (!quiz.exists) return null;
  const questions = await d.collection("quiz_questions").where("quiz_id", "==", quizId).orderBy("sort_order", "asc").get();
  // Options are stored on the question WITHOUT the correct flag; correct
  // answers live in the server-only quiz_answers collection.
  return {
    quiz: { id: quiz.id, title: String(quiz.data()!.title ?? ""), pass_percent: quiz.data()!.pass_percent ?? 60 },
    course: { id: course.id, slug: course.slug, title: course.title },
    questions: questions.docs.flatMap((q) =>
      ((q.data().options ?? []) as { id: string; option_text: string }[]).map((o) => ({
        id: o.id,
        question_id: q.id,
        option_text: o.option_text,
        question: q.data().question,
        explanation: q.data().explanation ?? "",
      })),
    ),
    questionList: questions.docs.map((q) => ({ id: q.id, question: q.data().question, explanation: q.data().explanation ?? "" })),
  };
}

export async function getCertificatesPage(d: Db, uid: string) {
  const [certs, courses] = await Promise.all([
    d.collection("certificates").where("user_id", "==", uid).orderBy("issued_at", "desc").get(),
    d.collection("courses").get(),
  ]);
  return {
    certificates: certs.docs.map((c) => ({
      id: c.id, certificate_id: c.data().certificate_id, course_id: c.data().course_id,
      issued_at: iso(c.data().issued_at), verification_status: c.data().verification_status ?? "valid",
    })),
    courses: courses.docs.map((c) => ({ id: c.id, title: c.data().title, slug: c.data().slug })),
  };
}

// ---------------------------------------------------------------------------
// Onboarding / settings / security
// ---------------------------------------------------------------------------
export async function getOnboardingData(d: Db, uid: string) {
  const [profile, consent, verifications, countries] = await Promise.all([
    d.collection("profiles").doc(uid).get(),
    d.collection("guardian_consents").doc(uid).get(),
    d.collection("identity_verifications").where("user_id", "==", uid).orderBy("created_at", "desc").limit(1).get(),
    d.collection("countries").orderBy("name", "asc").get(),
  ]);
  const v = verifications.docs[0];
  return {
    profile: profile.exists
      ? {
          id: profile.id, full_name: profile.data()?.full_name ?? "", date_of_birth: profile.data()?.date_of_birth ?? "",
          age_verified: profile.data()?.age_verified ?? false, school_name: profile.data()?.school_name ?? "",
          class_grade: profile.data()?.class_grade ?? "", country: profile.data()?.country ?? "",
        }
      : null,
    consent: consent.exists ? { status: consent.data()!.status, consent_method: consent.data()!.consent_method, guardian_name: consent.data()!.guardian_name ?? "", guardian_email: consent.data()!.guardian_email ?? "" } : null,
    verification: v ? { verification_status: v.data().verification_status, verification_type: v.data().verification_type, created_at: iso(v.data().created_at), rejection_reason: v.data().rejection_reason ?? "" } : null,
    countries: countries.docs.map((c) => ({ id: c.id, name: c.data().name, consent_required: c.data().consent_required ?? true, consent_min_age: c.data().consent_min_age ?? 13 })),
  };
}

export async function getSettingsData(d: Db, uid: string) {
  const [profile, settings, memories, countries] = await Promise.all([
    d.collection("profiles").doc(uid).get(),
    d.collection("user_security_settings").doc(uid).get(),
    d.collection("user_memories").where("user_id", "==", uid).orderBy("created_at", "desc").get(),
    d.collection("countries").orderBy("name", "asc").get(),
  ]);
  const p = profile.data();
  const s = settings.data();
  return {
    profile: p
      ? {
          id: profile.id, full_name: p.full_name ?? "", email: p.email ?? "", phone: p.phone ?? "",
          school_name: p.school_name ?? "", class_grade: p.class_grade ?? "", country: p.country ?? "", date_of_birth: p.date_of_birth ?? "",
        }
      : null,
    settings: s
      ? {
          memory_enabled: s.memory_enabled ?? true, chat_history_enabled: s.chat_history_enabled ?? true,
          notifications_email: s.notifications_email ?? true, notifications_push: s.notifications_push ?? false,
          notifications_security_alerts: s.notifications_security_alerts ?? true,
          data_export_requested_at: s.data_export_requested_at ? iso(s.data_export_requested_at) : null,
          deletion_requested_at: s.deletion_requested_at ? iso(s.deletion_requested_at) : null,
        }
      : null,
    memories: memories.docs.map((m) => ({ id: m.id, memory: m.data().memory, source: m.data().source ?? "ai", created_at: iso(m.data().created_at) })),
    countries: countries.docs.map((c) => ({ id: c.id, name: c.data().name })),
  };
}

export async function getSecurityPageData(d: Db, user: SessionUser) {
  const [events, sessions, score, profile, settings, progress, certs] = await Promise.all([
    d.collection("security_events").where("user_id", "==", user.uid).orderBy("created_at", "desc").limit(50).get(),
    d.collection("user_sessions").where("user_id", "==", user.uid).orderBy("last_seen_at", "desc").limit(20).get(),
    securityScore(d, user),
    d.collection("profiles").doc(user.uid).get(),
    d.collection("user_security_settings").doc(user.uid).get(),
    d.collection("course_progress").where("user_id", "==", user.uid).where("status", "==", "completed").get(),
    d.collection("certificates").where("user_id", "==", user.uid).get(),
  ]);
  return {
    events: events.docs.map((e) => ({ id: e.id, event_type: e.data().event_type, metadata: e.data().metadata ?? {}, created_at: iso(e.data().created_at) })),
    sessions: sessions.docs.map((s) => ({ id: s.id, device_name: s.data().device_name ?? "", last_seen_at: iso(s.data().last_seen_at), revoked_at: s.data().revoked_at ? iso(s.data().revoked_at) : null })),
    score,
    ageVerified: profile.data()?.age_verified ?? false,
    settings: {
      memory_enabled: settings.data()?.memory_enabled ?? true,
      chat_history_enabled: settings.data()?.chat_history_enabled ?? true,
      notifications_security_alerts: settings.data()?.notifications_security_alerts ?? true,
    },
    completedCount: progress.size,
    certificateCount: certs.size,
  };
}

// ---------------------------------------------------------------------------
// Scams / reports / scanner
// ---------------------------------------------------------------------------
export async function getScamsData(d: Db) {
  const [categories, articles] = await Promise.all([
    d.collection("scam_categories").where("status", "==", "active").orderBy("sort_order", "asc").get(),
    d.collection("scam_articles").where("status", "==", "active").orderBy("title", "asc").get(),
  ]);
  return {
    categories: categories.docs.map((c) => ({ id: c.id, slug: c.data().slug, name: c.data().name, description: c.data().description ?? "", icon: c.data().icon ?? "shield" })),
    articles: articles.docs.map((a) => ({ id: a.id, category_id: String(a.data().category_id ?? ""), title: String(a.data().title ?? ""), slug: String(a.data().slug ?? ""), description: String(a.data().description ?? ""), source_name: String(a.data().source_name ?? ""), last_verified: a.data().last_verified ? iso(a.data().last_verified) : "" })),
  };
}

export async function getScamArticle(d: Db, slug: string) {
  const snap = await d.collection("scam_articles").where("slug", "==", slug).where("status", "==", "active").limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() } as Record<string, unknown>;
}

export async function getReportPageData(d: Db) {
  const [categories, resources, countries] = await Promise.all([
    d.collection("scam_categories").where("status", "==", "active").orderBy("sort_order", "asc").get(),
    d.collection("reporting_resources").where("status", "==", "active").orderBy("organization", "asc").get(),
    d.collection("countries").orderBy("name", "asc").get(),
  ]);
  return {
    categories: categories.docs.map((c) => ({ id: c.id, name: c.data().name })),
    resources: resources.docs.map((r) => ({ organization: r.data().organization, official_url: r.data().official_url, phone: r.data().phone ?? "", description: r.data().description ?? "", country_id: r.data().country_id, last_verified: iso(r.data().last_verified) })),
    countries: countries.docs.map((c) => ({ id: c.id, name: c.data().name })),
  };
}

export async function getScannerData(d: Db, uid: string) {
  const analyses = await d.collection("security_analyses").where("user_id", "==", uid).orderBy("created_at", "desc").limit(10).get();
  return analyses.docs.map((a) => ({ id: a.id, risk_level: a.data().risk_level, confidence: a.data().confidence ?? 0, recommendation: a.data().recommendation ?? "", created_at: iso(a.data().created_at) }));
}

// ---------------------------------------------------------------------------
// Admin pages: permission matrix for nav gating
// ---------------------------------------------------------------------------
export async function getAdminPermissions(d: Db, uid: string) {
  if (!(await isAdmin(d, uid))) return [] as string[];
  const assignment = await d.collection("admin_role_assignments").doc(uid).get();
  if (!assignment.exists) return [];
  const roleId = assignment.data()!.role_id as string;
  const links = await d.collection("admin_role_permissions").where("role_id", "==", roleId).get();
  const permIds = links.docs.map((l) => l.id.split("__")[1]).filter(Boolean);
  if (permIds.length === 0) return [];
  const docs = await d.getAll(...permIds.map((id) => d.collection("admin_permissions").doc(id)));
  return docs.filter((p) => p.exists).map((p) => p.data()!.code as string);
}
