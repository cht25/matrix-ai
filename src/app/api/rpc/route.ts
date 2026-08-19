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
import { nowTs } from "@/lib/firebase/admin";

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
    if (!(await rpc.hasPermission(d, u.uid, "reports.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
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
    const snap = await d.collection("identity_verifications").where("verification_status", "==", "pending_review").orderBy("created_at", "asc").get();
    return snap.docs.map((v) => ({ id: v.id, user_id: v.data().user_id, verification_type: v.data().verification_type, verification_reference: v.data().verification_reference ?? "", created_at: v.data().created_at?.toDate?.().toISOString() ?? "" }));
  },

  admin_pending_consents: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "consent.review"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("guardian_consents").where("status", "==", "pending").orderBy("created_at", "asc").get();
    return snap.docs.map((c) => ({ id: c.id, user_id: c.id, status: c.data().status, consent_method: c.data().consent_method ?? "", guardian_name: c.data().guardian_name ?? "", guardian_email: c.data().guardian_email ?? "", created_at: c.data().created_at?.toDate?.().toISOString() ?? "" }));
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
    if (!(await rpc.hasPermission(d, u.uid, "reports.manage"))) throw new RpcError("PERMISSION_DENIED", 403);
    const snap = await d.collection("scam_reports").orderBy("created_at", "desc").limit(50).get();
    return snap.docs.map((r) => ({
      id: r.id, platform: r.data().platform ?? "", description: r.data().description ?? "", money_lost: r.data().money_lost ?? 0,
      account_compromised: r.data().account_compromised ?? false, personal_information_shared: r.data().personal_information_shared ?? false,
      country: r.data().country ?? "", status: r.data().status ?? "", created_at: r.data().created_at?.toDate?.().toISOString() ?? "", admin_notes: r.data().admin_notes ?? "",
    }));
  },
};
