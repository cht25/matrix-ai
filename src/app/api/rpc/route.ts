// =============================================================================
// MATRIX AI — /api/rpc: the typed server-mutation endpoint (Firebase port of
// the Postgres RPC layer). Clients POST { action, ...args } with the session
// cookie; every action re-checks authentication, ownership and RBAC — the
// same contract the old SECURITY DEFINER functions + RLS enforced.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser, type SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";
import * as rpc from "@/lib/server/rpc";
import * as projects from "@/lib/server/projects";
import * as deploy from "@/lib/server/deploy";
import { nowTs } from "@/lib/firebase/admin";
import { ascDoc, descDoc } from "@/lib/server/sort";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Handler = (d: ReturnType<typeof adminDb>, user: SessionUser, body: Record<string, unknown>) => Promise<unknown>;

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback = false) => (typeof v === "boolean" ? v : fallback);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  const action = str(body.action);
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const d = adminDb();
  try {
    const handler = ACTIONS[action];
    if (!handler) return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
    const result = await handler(d, user, body);
    return NextResponse.json({ data: result ?? true });
  } catch (err) {
    if (err instanceof RpcError) return NextResponse.json({ error: err.code }, { status: err.status });
    if (err instanceof z.ZodError) return NextResponse.json({ error: "VALIDATION_FAILED", detail: err.issues[0]?.message }, { status: 400 });
    const msg = err instanceof Error ? err.message : "internal error";
    return NextResponse.json({ error: "INTERNAL", detail: msg.slice(0, 300) }, { status: 500 });
  }
}

const ACTIONS: Record<string, Handler> = {
  // --- onboarding / identity --------------------------------------------------
  complete_profile: (d, u, b) =>
    rpc.completeProfile(d, u, {
      dob: z.string().min(8).nullish().parse(b.dob) ?? "",
      full_name: str(b.full_name),
      school_name: str(b.school_name),
      class_grade: str(b.class_grade),
      country: b.country ? str(b.country) : null,
    }),

  submit_guardian_consent: (d, u, b) =>
    rpc.submitGuardianConsent(d, u, {
      guardian_name: z.string().min(2).parse(b.guardian_name),
      guardian_email: z.string().email().parse(b.guardian_email),
      relationship: str(b.relationship),
    }),

  submit_identity_verification: (d, u, b) =>
    rpc.submitIdentityVerification(d, u, {
      verification_type: z.enum(["birth_certificate", "passport", "national_id", "external_provider"]).parse(b.verification_type),
      verification_reference: z.string().startsWith(`identity-documents/${u.uid}/`).parse(b.verification_reference),
    }),

  submit_identity_number: (d, u, b) =>
    rpc.submitIdentityNumber(d, u, { birth_certificate_number: z.string().min(1).max(64).parse(b.birth_certificate_number) }),

  onboarding_status: (d, u) => rpc.profileOnboardingComplete(d, u.uid).then((complete) => ({ complete })),

  theme_update: (d, u, b) => rpc.updateTheme(d, u, { theme: str(b.theme), theme_template: str(b.theme_template) }),
  notifications_list: (d, u) => rpc.listNotifications(d, u),
  notifications_mark_read: (d, u, b) => rpc.markNotificationsRead(d, u, { id: b.id ? str(b.id) : undefined, all: bool(b.all) }),
  usage_summary: (d, u) => rpc.usageSummary(d, u),

  project_list: (d, u) => projects.listProjects(d, u),
  project_ensure: (d, u, b) =>
    projects.ensureProject(d, u, { conversation_id: b.conversation_id ? str(b.conversation_id) : null, title: str(b.title) }),
  project_get: (d, u, b) => projects.getProject(d, u, z.string().min(1).parse(b.id)),
  project_update: (d, u, b) =>
    projects.updateProject(d, u, { id: z.string().min(1).parse(b.id), title: b.title ? str(b.title) : undefined, description: b.description ? str(b.description) : undefined, archive: bool(b.archive) }),
  project_file_upsert: (d, u, b) =>
    projects.upsertProjectFile(d, u, {
      project_id: z.string().min(1).parse(b.project_id),
      path: z.string().min(1).parse(b.path),
      content: z.string().parse(b.content ?? ""),
      encoding: b.encoding === "base64" ? "base64" : "utf8",
      source: str(b.source, "user"),
    }),
  project_file_delete: (d, u, b) =>
    projects.deleteProjectFile(d, u, { project_id: z.string().min(1).parse(b.project_id), path: z.string().min(1).parse(b.path) }),
  project_file_rename: (d, u, b) =>
    projects.renameProjectFile(d, u, { project_id: z.string().min(1).parse(b.project_id), from: z.string().min(1).parse(b.from), to: z.string().min(1).parse(b.to) }),
  project_apply_files: (d, u, b) =>
    projects.applyProjectFiles(d, u, {
      project_id: z.string().min(1).parse(b.project_id),
      files: z.array(z.object({ path: z.string(), content: z.string(), language: z.string().optional(), encoding: z.enum(["utf8", "base64"]).optional() })).parse(b.files).map((file) => ({
        path: file.path,
        content: file.content,
        language: file.language ?? "text",
        encoding: file.encoding ?? "utf8",
      })),
      source: str(b.source, "agent"),
      title: b.title ? str(b.title) : undefined,
    }),
  project_version_save: (d, u, b) =>
    projects.saveProjectVersion(d, u, { project_id: z.string().min(1).parse(b.project_id), source: str(b.source, "manual"), summary: str(b.summary) }),
  project_version_list: (d, u, b) => projects.listProjectVersions(d, u, z.string().min(1).parse(b.project_id)),
  project_version_restore: (d, u, b) =>
    projects.restoreProjectVersion(d, u, { project_id: z.string().min(1).parse(b.project_id), version_id: z.string().min(1).parse(b.version_id) }),
  project_set_env: (d, u, b) =>
    projects.setProjectEnv(d, u, { project_id: z.string().min(1).parse(b.project_id), env: z.record(z.string()).parse(b.env ?? {}) }),
  project_publish: (d, u, b) => deploy.publishProject(d, u, { project_id: z.string().min(1).parse(b.project_id), slug: b.slug ? str(b.slug) : undefined }),
  snippet_publish: (d, u, b) =>
    deploy.publishSnippet(d, u, {
      lang: str(b.lang, "html"),
      code: z.string().min(1).max(400_000).parse(b.code),
      title: b.title ? str(b.title) : undefined,
      slug: b.slug ? str(b.slug) : undefined,
    }),
  project_unpublish: (d, u, b) => deploy.unpublishProject(d, u, z.string().min(1).parse(b.project_id)),
  project_deployment: (d, u, b) => deploy.getDeployment(d, u, z.string().min(1).parse(b.project_id)),
  project_add_domain: (d, u, b) => deploy.addProjectDomain(d, u, { project_id: z.string().min(1).parse(b.project_id), domain: z.string().min(3).parse(b.domain) }),
  project_verify_domain: (d, u, b) => deploy.verifyProjectDomain(d, u, z.string().min(1).parse(b.project_id)),

  admin_bootstrap: (d, u, b) => rpc.bootstrapAdmin(d, u, z.string().min(1).parse(b.key)),
  admin_set_role: (d, u, b) => rpc.adminSetUserRole(d, u, { uid: z.string().min(1).parse(b.uid), role: z.string().min(1).parse(b.role) }),
  admin_set_disabled: (d, u, b) => rpc.adminSetUserDisabled(d, u, { uid: z.string().min(1).parse(b.uid), disabled: z.boolean().parse(b.disabled) }),
  course_upsert: (d, u, b) =>
    rpc.upsertCourse(d, u, {
      id: b.id ? str(b.id) : undefined,
      title: z.string().min(2).parse(b.title),
      slug: z.string().min(2).parse(b.slug),
      description: str(b.description),
      level: str(b.level, "beginner"),
      duration_minutes: Number(b.duration_minutes ?? 30),
      icon: str(b.icon, "book"),
      status: str(b.status, "draft"),
      modules: Array.isArray(b.modules) ? (b.modules as never) : undefined,
    }),
  admin_course_get: (d, u, b) => rpc.getAdminCourse(d, u, z.string().min(1).parse(b.id)),
  admin_seed_rbac: async (d, u) => {
    if ((await rpc.adminRoleOf(d, u.uid)) !== "super_admin") throw new RpcError("PERMISSION_DENIED", 403);
    return rpc.seedAdminRbac(d);
  },
  admin_ai_usage: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "ai.view"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("ai_usage_logs").get();
    return snap.docs
      .sort(descDoc("created_at"))
      .slice(0, 80)
      .map((e) => ({
        id: e.id,
        user_id: e.data().user_id ?? "",
        model: e.data().model ?? "",
        request_type: e.data().request_type ?? "",
        status: e.data().status ?? "",
        latency_ms: e.data().latency_ms ?? 0,
        created_at: e.data().created_at?.toDate?.().toISOString() ?? "",
      }));
  },
  admin_live_sites: async (d, u) => {
    if (!(await rpc.isAdmin(d, u.uid))) throw new RpcError("PERMISSION_DENIED", 403);
    return deploy.listLiveSites(d);
  },
  admin_unpublish_site: async (d, u, b) => {
    if (!(await rpc.isAdmin(d, u.uid))) throw new RpcError("PERMISSION_DENIED", 403);
    const slug = z.string().min(3).parse(b.slug);
    await deploy.adminUnpublishSite(d, slug);
    await rpc.logAudit(d, u.uid, "site_unpublished", "published_sites", slug, str(b.reason));
    return true;
  },

  // --- security events & sessions ----------------------------------------------
  record_security_event: (d, u, b) => rpc.recordSecurityEvent(d, u, str(b.event_type), (b.metadata as Record<string, unknown>) ?? {}),
  revoke_session: (d, u, b) => rpc.revokeSession(d, u, z.string().min(1).parse(b.session_id)),

  // --- learning ----------------------------------------------------------------
  update_course_progress: (d, u, b) => rpc.updateCourseProgress(d, u, z.string().min(1).parse(b.lesson_id), str(b.status, "started")),
  submit_quiz_attempt: async (d, u, b) => {
    const answers = z.array(z.object({ question_id: z.string(), option_id: z.string().nullable() })).parse(b.answers);
    return rpc.submitQuizAttempt(d, u, z.string().min(1).parse(b.quiz_id), answers);
  },
  issue_certificate: async (d, u, b) => {
    const result = await rpc.issueCertificate(d, u, z.string().min(1).parse(b.course_id));
    return result;
  },
  security_score: (d, u) => rpc.securityScore(d, u),

  // --- conversations (owner-scoped mutations + export) --------------------------
  conversation_update: async (d, u, b) => {
    const id = z.string().min(1).parse(b.id);
    const ref = d.collection("conversations").doc(id);
    const doc = await ref.get();
    if (!doc.exists || doc.data()!.user_id !== u.uid) throw new RpcError("NOT_FOUND", 404);
    const patch: Record<string, unknown> = { updated_at: nowTs() };
    if (typeof b.title === "string") patch.title = b.title.trim().slice(0, 120) || "Untitled";
    if (bool(b.archive)) patch.archived_at = nowTs();
    if (bool(b.delete)) patch.deleted_at = nowTs();
    await ref.set(patch, { merge: true });
    return true;
  },

  conversation_messages: async (d, u, b) => {
    const id = z.string().min(1).parse(b.conversation_id);
    const conv = await d.collection("conversations").doc(id).get();
    if (!conv.exists || conv.data()!.user_id !== u.uid) throw new RpcError("NOT_FOUND", 404);
    const messages = await conv.ref.collection("messages").orderBy("created_at", "asc").get();
    return messages.docs.map((m) => ({
      role: m.data().role,
      content: m.data().content,
      created_at: m.data().created_at?.toDate?.().toISOString() ?? "",
    }));
  },

  // --- profile & settings (owner-scoped, non-sensitive fields only) -------------
  profile_update: async (d, u, b) => {
    const patch: Record<string, unknown> = { updated_at: nowTs() };
    if (typeof b.full_name === "string") patch.full_name = b.full_name.trim().slice(0, 120);
    if (typeof b.phone === "string") patch.phone = b.phone.trim().slice(0, 30);
    if (typeof b.school_name === "string") patch.school_name = b.school_name.trim().slice(0, 120);
    if (typeof b.class_grade === "string") patch.class_grade = b.class_grade.trim().slice(0, 40);
    if (typeof b.country === "string" && b.country) patch.country = b.country.slice(0, 2).toUpperCase();
    // Sensitive columns (date_of_birth / age_verified*) are NOT patchable here —
    // only complete_profile / review_identity_verification may set them.
    await d.collection("profiles").doc(u.uid).set(patch, { merge: true });
    return true;
  },

  settings_update: async (d, u, b) => {
    const patch: Record<string, unknown> = { updated_at: nowTs() };
    for (const key of ["memory_enabled", "chat_history_enabled", "notifications_email", "notifications_push", "notifications_security_alerts"]) {
      if (typeof b[key] === "boolean") patch[key] = b[key];
    }
    if (bool(b.mark_export_requested)) patch.data_export_requested_at = nowTs();
    if (bool(b.mark_deletion_requested)) patch.deletion_requested_at = nowTs();
    await d.collection("user_security_settings").doc(u.uid).set(patch, { merge: true });
    return true;
  },

  memory_delete: async (d, u, b) => {
    if (b.all === true) {
      const snap = await d.collection("user_memories").where("user_id", "==", u.uid).get();
      await Promise.all(snap.docs.map((m) => m.ref.delete()));
      return true;
    }
    const id = z.string().min(1).parse(b.id);
    const ref = d.collection("user_memories").doc(id);
    const doc = await ref.get();
    if (!doc.exists || doc.data()!.user_id !== u.uid) throw new RpcError("NOT_FOUND", 404);
    await ref.delete();
    return true;
  },

  // --- scam reports --------------------------------------------------------------
  report_submit: async (d, u, b) => {
    const category = await d.collection("scam_categories").doc(z.string().min(1).parse(b.category_id)).get();
    if (!category.exists) throw new RpcError("CATEGORY_NOT_FOUND", 404);
    await d.collection("scam_reports").add({
      user_id: u.uid,
      category_id: category.id,
      platform: str(b.platform).slice(0, 80),
      description: z.string().min(10).max(4000).parse(b.description),
      money_lost: Number(b.money_lost) >= 0 ? Number(b.money_lost) : 0,
      account_compromised: bool(b.account_compromised),
      personal_information_shared: bool(b.personal_information_shared),
      evidence_available: bool(b.evidence_available),
      country: b.country ? str(b.country).slice(0, 2).toUpperCase() : "",
      status: "submitted",
      admin_notes: "",
      created_at: nowTs(),
      updated_at: nowTs(),
    });
    return true;
  },

  // --- admin: users / verification / consent --------------------------------------
  admin_list_users: (d, u) => rpc.adminListUsers(d, u),
  review_identity_verification: (d, u, b) =>
    rpc.reviewIdentityVerification(d, u, {
      verification_id: z.string().min(1).parse(b.verification_id),
      approve: z.boolean().parse(b.approve),
      reason: str(b.reason),
    }),
  review_guardian_consent: (d, u, b) =>
    rpc.reviewGuardianConsent(d, u, {
      user_id: z.string().min(1).parse(b.user_id),
      approve: z.boolean().parse(b.approve),
      reason: str(b.reason),
    }),

  // --- admin: privileged conversation access --------------------------------------
  request_admin_access: (d, u, b) =>
    rpc.requestAdminAccess(d, u, {
      target_user_id: z.string().min(1).parse(b.target_user_id),
      scope: str(b.scope, "conversations"),
      reason: z.string().min(3).max(500).parse(b.reason),
      duration_hours: Number(b.duration_hours ?? 24),
    }),
  admin_list_conversations: (d, u, b) => rpc.adminListConversations(d, u, z.string().min(1).parse(b.grant_id)),
  admin_view_conversation: (d, u, b) =>
    rpc.adminViewConversation(d, u, z.string().min(1).parse(b.grant_id), z.string().min(1).parse(b.conversation_id)),

  // --- admin: content & reports ---------------------------------------------------
  log_audit: async (d, u, b) => {
    if (!(await rpc.isAdmin(d, u.uid))) throw new RpcError("PERMISSION_DENIED", 403);
    return rpc.logAudit(d, u.uid, z.string().min(1).parse(b.action), str(b.target_type), str(b.target_id), str(b.reason), (b.metadata as Record<string, unknown>) ?? {});
  },

  article_status: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "content.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
    const status = z.enum(["active", "inactive", "review"]).parse(b.status);
    await d.collection("scam_articles").doc(z.string().min(1).parse(b.id)).set(
      { status, last_verified: nowTs(), updated_at: nowTs() }, { merge: true },
    );
    return true;
  },

  course_status: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "content.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
    const status = z.enum(["draft", "published", "archived"]).parse(b.status);
    await d.collection("courses").doc(z.string().min(1).parse(b.id)).set({ status, updated_at: nowTs() }, { merge: true });
    return true;
  },

  report_status: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "reports.view"))) throw new RpcError("PERMISSION_DENIED", 403);
    const status = z.enum(["submitted", "in_review", "resolved", "closed"]).parse(b.status);
    await d.collection("scam_reports").doc(z.string().min(1).parse(b.id)).set(
      { status, admin_notes: str(b.admin_notes).slice(0, 2000), updated_at: nowTs() }, { merge: true },
    );
    return true;
  },

  // --- admin: security dashboards ---------------------------------------------------
  admin_security_events: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "security.view"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("security_events").orderBy("created_at", "desc").limit(50).get();
    return snap.docs.map((e) => ({ id: e.id, user_id: e.data().user_id, event_type: e.data().event_type, created_at: e.data().created_at?.toDate?.().toISOString() ?? "" }));
  },

  admin_sessions: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "security.view"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("user_sessions").orderBy("last_seen_at", "desc").limit(50).get();
    return snap.docs.map((s) => ({ id: s.id, user_id: s.data().user_id, device_name: s.data().device_name ?? "", last_seen_at: s.data().last_seen_at?.toDate?.().toISOString() ?? "", revoked_at: s.data().revoked_at ? s.data().revoked_at.toDate().toISOString() : null }));
  },

  admin_safety_events: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "security.view"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("ai_safety_events").orderBy("created_at", "desc").limit(50).get();
    return snap.docs.map((e) => ({ id: e.id, event_type: e.data().event_type, detail: e.data().detail ?? "", created_at: e.data().created_at?.toDate?.().toISOString() ?? "" }));
  },

  admin_audit_logs: async (d, u) => {
    if (!(await rpc.isAdmin(d, u.uid))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("audit_logs").orderBy("created_at", "desc").limit(100).get();
    return snap.docs.map((a) => ({ id: a.id, actor_id: a.data().actor_id ?? "", action: a.data().action, target_type: a.data().target_type ?? "", target_id: a.data().target_id ?? "", reason: a.data().reason ?? "", created_at: a.data().created_at?.toDate?.().toISOString() ?? "" }));
  },

  admin_grants: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "privacy.access"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("admin_access_grants").orderBy("created_at", "desc").limit(20).get();
    return snap.docs.map((g) => ({ id: g.id, target_user_id: g.data().target_user_id, scope: g.data().scope ?? "", reason: g.data().reason ?? "", status: g.data().status ?? "", expires_at: g.data().expires_at?.toDate?.().toISOString() ?? "", created_at: g.data().created_at?.toDate?.().toISOString() ?? "" }));
  },

  admin_pending_verifications: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "verification.review"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("identity_verifications").where("verification_status", "==", "pending_review").get();
    return snap.docs.sort(ascDoc("created_at")).map((v) => ({ id: v.id, user_id: v.data().user_id, verification_type: v.data().verification_type, verification_reference: v.data().verification_reference ?? "", created_at: v.data().created_at?.toDate?.().toISOString() ?? "" }));
  },

  admin_pending_consents: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "consent.review"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("guardian_consents").where("status", "==", "pending").get();
    return snap.docs.sort(ascDoc("created_at")).map((c) => ({ id: c.id, user_id: c.id, status: c.data().status, consent_method: c.data().consent_method ?? "", guardian_name: c.data().guardian_name ?? "", guardian_email: c.data().guardian_email ?? "", created_at: c.data().created_at?.toDate?.().toISOString() ?? "" }));
  },

  admin_articles: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "content.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("scam_articles").orderBy("title", "asc").limit(500).get();
    return snap.docs.map((a) => ({ id: a.id, title: a.data().title, slug: a.data().slug, category_id: a.data().category_id ?? null, status: a.data().status ?? "review", last_verified: a.data().last_verified?.toDate?.().toISOString() ?? "", source_name: a.data().source_name ?? "" }));
  },

  admin_categories: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "content.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("scam_categories").where("status", "==", "active").get();
    return snap.docs.map((c) => ({ id: c.id, name: c.data().name }));
  },

  admin_reports: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "reports.view"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("scam_reports").limit(200).get();
    return snap.docs.sort(descDoc("created_at")).slice(0, 50).map((r) => ({
      id: r.id, platform: r.data().platform ?? "", description: r.data().description ?? "", money_lost: r.data().money_lost ?? 0,
      account_compromised: r.data().account_compromised ?? false, personal_information_shared: r.data().personal_information_shared ?? false,
      country: r.data().country ?? "", status: r.data().status ?? "", created_at: r.data().created_at?.toDate?.().toISOString() ?? "", admin_notes: r.data().admin_notes ?? "",
    }));
  },
};
