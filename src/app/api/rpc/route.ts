// =============================================================================
// MATRIX AI — /api/rpc: the typed server-mutation endpoint (Firebase port of
// the Postgres RPC layer). Clients POST { action, ...args } with the session
// cookie; every action re-checks authentication, ownership and RBAC — the
// same contract the old SECURITY DEFINER functions + RLS enforced.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { type SessionUser } from "@/lib/firebase/session";
import { getApiSessionUser, hasDeviceScope, rpcDeviceScope } from "@/lib/firebase/device-session";
import { RpcError } from "@/lib/server/rpc";
import * as rpc from "@/lib/server/rpc";
import * as aiRuntime from "@/lib/ai/runtime-config";
import * as managedAI from "@/lib/ai/managed-providers";
import * as imageConfig from "@/lib/ai/image/config";
import { getConversationHistoryPage } from "@/lib/server/queries";
import * as projects from "@/lib/server/projects";
import * as deploy from "@/lib/server/deploy";
import * as design from "@/lib/server/design";
import * as family from "@/lib/server/family";
import * as pairing from "@/lib/server/pairing";
import * as esp32 from "@/lib/server/esp32";
import * as agentTasks from "@/lib/server/agent-tasks";
import * as toolApprovals from "@/lib/server/tool-approvals";
import * as agentDeploy from "@/lib/server/agent-deploy";
import * as automations from "@/lib/server/automations";
import * as canvas from "@/lib/server/canvas";
import { canvasDocumentSchema } from "@/lib/canvas";
import { designTokensSchema } from "@/lib/design/tokens";
import { latestBuildRunForProject, readBuildRun } from "@/lib/server/build";
import { nowTs } from "@/lib/firebase/admin";
import { ascDoc, descDoc } from "@/lib/server/sort";
import { ADMIN_ROLES, NO_ROLE } from "@/lib/roles";
import { ALL_ADMIN_PERMISSION_CODES } from "@/lib/admin-rbac";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- standard response envelope ---------------------------------------------
// Success: { success: true, data }        Error: { success: false, error: { code, message } }
// `error` is also mirrored as a top-level string for backwards compatibility
// with older clients. The human-readable message is produced in the browser by
// src/lib/admin-errors.ts — the server only emits stable machine codes.
function ok(data: unknown) {
  return NextResponse.json({ success: true, data });
}
function fail(code: string, status: number) {
  return NextResponse.json(
    { success: false, error: { code, message: code }, data: null },
    { status },
  );
}

type Handler = (d: ReturnType<typeof adminDb>, user: SessionUser, body: Record<string, unknown>) => Promise<unknown>;

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback = false) => (typeof v === "boolean" ? v : fallback);

function isAllowedAvatarUrl(url: string): boolean {
  if (!url) return true;
  if (url.startsWith("data:image/jpeg;base64,") || url.startsWith("data:image/png;base64,") || url.startsWith("data:image/webp;base64,")) {
    return url.length <= 180_000;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    return (
      host === "res.cloudinary.com" ||
      host.endsWith(".googleusercontent.com") ||
      host.endsWith(".fbcdn.net") ||
      host.endsWith(".fbsbx.com")
    );
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("BAD_REQUEST", 400);
  }
  const action = str(body.action);

  const user = await getApiSessionUser(req);
  if (!user) return fail("UNAUTHENTICATED", 401);

  const d = adminDb();
  try {
    const scope = rpcDeviceScope(action);
    if (user.deviceId && (!scope || !hasDeviceScope(user, scope))) return fail("DEVICE_SCOPE_DENIED", 403);
    const handler = ACTIONS[action];
    if (!handler) return fail("UNKNOWN_ACTION", 400);
    const result = await handler(d, user, body);
    return ok(result ?? true);
  } catch (err) {
    if (err instanceof RpcError) return fail(err.code, err.status);
    if (err instanceof z.ZodError) {
      console.warn(`[MATRIX] /api/rpc action "${action}" validation failed`, err.issues[0]?.message);
      return fail("BAD_REQUEST", 400);
    }
    // Never leak internal error text (stack, SQL, file paths, provider
    // details) to the browser — log server-side, return a stable code.
    console.error(`[MATRIX] /api/rpc action "${action}" failed`, err);
    return fail("INTERNAL", 500);
  }
}

const ACTIONS: Record<string, Handler> = {
  canvas_create: (d, u, b) => canvas.createCanvas(d, u, { title: z.string().min(1).max(120).parse(b.title), project_id: b.project_id ? z.string().max(128).parse(b.project_id) : null }),
  canvas_import: (d, u, b) => canvas.createCanvas(d, u, { title: z.string().min(1).max(120).parse(b.title), document: canvasDocumentSchema.parse(b.document) }),
  canvas_list: (d, u) => canvas.listCanvases(d, u),
  canvas_get: (d, u, b) => canvas.getCanvas(d, u, z.string().min(1).max(128).parse(b.id)),
  canvas_save: (d, u, b) => canvas.saveCanvas(d, u, { id: z.string().min(1).max(128).parse(b.id), revision: z.number().int().min(1).parse(b.revision), title: z.string().min(1).max(120).parse(b.title), project_id: b.project_id ? z.string().max(128).parse(b.project_id) : null, document: canvasDocumentSchema.parse(b.document) }),
  canvas_delete: (d, u, b) => canvas.deleteCanvas(d, u, z.string().min(1).max(128).parse(b.id)),
  canvas_version_create: (d, u, b) => canvas.saveCanvasVersion(d, u, z.string().min(1).max(128).parse(b.id)),
  canvas_versions: (d, u, b) => canvas.listCanvasVersions(d, u, z.string().min(1).max(128).parse(b.id)),
  canvas_version_restore: (d, u, b) => canvas.restoreCanvasVersion(d, u, z.string().min(1).max(128).parse(b.id), z.string().min(1).max(128).parse(b.version_id)),

  model_preference_set: async (d, u, b) => {
    const providerId = z.string().max(80).parse(b.provider_id ?? "");
    const modelId = z.string().max(220).parse(b.model_id ?? "");
    if (providerId || modelId) await import("@/lib/ai/config").then((m) => m.resolveSelectedAIRoute(d, providerId, modelId));
    await d.collection("user_security_settings").doc(u.uid).set({ ai_provider_id: providerId, ai_model_id: modelId, updated_at: nowTs() }, { merge: true });
    return { provider_id: providerId, model_id: modelId };
  },
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

  // --- Dynamic Design Engine (validated tokens only; preview never writes) --
  design_preview: async (d, u, b) => design.previewDesign({ instruction: b.instruction ? str(b.instruction) : undefined, changes: b.changes as Record<string, unknown> | undefined }),
  design_save: (d, u, b) =>
    design.saveDesignConfig(d, u, {
      tokens: designTokensSchema.parse(b.tokens),
      source: b.source === "instruction" ? "instruction" : "manual",
      summary: str(b.summary, "Custom design"),
    }),
  design_current: (d, u) => design.getCurrentDesignConfig(d, u.uid),
  design_versions: (d, u) => design.listDesignVersions(d, u.uid),
  design_apply_version: (d, u, b) => design.applyDesignVersion(d, u, z.number().int().min(1).parse(b.version)),
  design_reset: (d, u) => design.resetDesignConfig(d, u),

  // --- MATRIX Family (server-enforced roles & relationships) ------------------
  family_create: (d, u, b) => family.createFamily(d, u, { name: z.string().min(2).max(80).parse(b.name) }),
  family_invite: (d, u, b) =>
    family.inviteMember(d, u, { family_id: z.string().min(1).parse(b.family_id), invitee_email: z.string().email().parse(b.invitee_email) }),
  family_invitation_revoke: (d, u, b) => family.revokeInvitation(d, u, z.string().min(1).max(200).parse(b.invitation_id)),
  family_invitation_review: (d, u, b) => family.reviewInvitation(d, u, z.string().min(10).max(200).parse(b.token)),
  family_accept: (d, u, b) => family.acceptInvitation(d, u, { token: z.string().min(10).max(200).parse(b.token) }),
  family_role_change: (d, u, b) =>
    family.changeMemberRole(d, u, { family_id: z.string().min(1).parse(b.family_id), member_id: z.string().min(1).parse(b.member_id), role: str(b.role) }),
  family_revoke: (d, u, b) =>
    family.revokeMember(d, u, { family_id: z.string().min(1).parse(b.family_id), member_id: z.string().min(1).parse(b.member_id) }),
  family_list: (d, u) => family.listFamiliesForUser(d, u.uid),
  family_members: (d, u, b) => family.listMembers(d, u, z.string().min(1).parse(b.family_id)),
  family_overview: (d, u, b) => family.familyOverview(d, u, z.string().min(1).parse(b.family_id)),
  family_rename: (d, u, b) =>
    family.renameFamily(d, u, { family_id: z.string().min(1).parse(b.family_id), name: z.string().min(2).max(80).parse(b.name) }),
  family_invitation_resend: (d, u, b) => family.resendInvitation(d, u, z.string().min(1).max(200).parse(b.invitation_id)),
  family_member_detail: (d, u, b) =>
    family.memberDetail(d, u, { family_id: z.string().min(1).parse(b.family_id), member_id: z.string().min(1).parse(b.member_id) }),
  family_features_update: (d, u, b) =>
    family.updateMemberFeatures(d, u, {
      family_id: z.string().min(1).parse(b.family_id),
      member_id: z.string().min(1).parse(b.member_id),
      features: z.array(z.string().max(40)).max(20).parse(b.features),
    }),
  family_primary_transfer: (d, u, b) =>
    family.transferPrimary(d, u, { family_id: z.string().min(1).parse(b.family_id), member_id: z.string().min(1).parse(b.member_id) }),
  family_mirror_start: (d, u, b) =>
    family.startMirrorSession(d, u, {
      family_id: z.string().min(1).parse(b.family_id),
      member_id: z.string().min(1).parse(b.member_id),
      device_id: b.device_id ? z.string().max(128).parse(b.device_id) : undefined,
    }),
  family_mirror_stop: (d, u, b) => family.stopMirrorSession(d, u, z.string().min(1).max(128).parse(b.session_id)),
  family_mirror_status: (d, u, b) => family.mirrorSessionStatus(d, u, z.string().min(1).max(128).parse(b.session_id)),
  family_mirror_consent: (d, u, b) =>
    family.setMirrorConsent(d, u, {
      family_id: z.string().min(1).parse(b.family_id),
      consent: z.enum(["grant", "revoke"]).parse(b.consent),
    }),
  family_mirror_grant: (d, u, b) =>
    family.grantMirrorAccess(d, u, { family_id: z.string().min(1).parse(b.family_id), member_id: z.string().min(1).parse(b.member_id) }),
  family_pairing_create: (d, u, b) =>
    family.createFamilyPairing(d, u, {
      family_id: z.string().min(1).parse(b.family_id),
      member_id: b.member_id ? z.string().min(1).parse(b.member_id) : undefined,
      device_label: b.device_label ? z.string().max(80).parse(b.device_label) : undefined,
    }),
  family_pairing_complete: (d, u, b) =>
    family.completeFamilyPairing(d, u, {
      pair_token: z.string().min(20).max(300).parse(b.pair_token),
      device_name: z.string().min(1).max(80).parse(b.device_name),
      device_type: z.string().min(1).max(40).parse(b.device_type),
      platform: z.string().min(1).max(40).parse(b.platform),
    }),
  family_devices: (d, u, b) => family.listFamilyDevices(d, u, z.string().min(1).parse(b.family_id)),
  family_device_revoke: (d, u, b) => family.revokeFamilyDevice(d, u, z.string().min(1).max(128).parse(b.device_id)),
  family_activity_report: (d, u, b) =>
    family.reportFamilyActivity(d, u, {
      device_id: z.string().min(1).max(128).parse(b.device_id),
      screen_time_minutes: b.screen_time_minutes === undefined ? 0 : z.number().min(0).max(1440).parse(b.screen_time_minutes),
      apps: b.apps,
      browser_history: b.browser_history,
      hidden_apps: b.hidden_apps,
    }),
  family_mirror_frame_upload: (d, u, b) =>
    family.uploadMirrorFrame(d, u, {
      session_id: b.session_id ? z.string().max(128).parse(b.session_id) : undefined,
      storage_path: b.storage_path ? z.string().max(240).parse(b.storage_path) : undefined,
      image_data_url: b.image_data_url ? z.string().max(4_500_000).parse(b.image_data_url) : undefined,
    }),
  family_mirror_active: (d, u) => family.activeMirrorAndLockForUser(d, u),
  family_device_lock: (d, u, b) =>
    family.setDeviceLock(d, u, {
      family_id: z.string().min(1).parse(b.family_id),
      member_id: z.string().min(1).parse(b.member_id),
      locked: z.boolean().parse(b.locked),
      reason: b.reason ? z.string().max(160).parse(b.reason) : undefined,
    }),
  family_request_parent_access: (d, u, b) =>
    family.requestParentAccess(d, u, {
      family_id: z.string().min(1).parse(b.family_id),
      kind: z.enum(["unlock_device", "disable_mirror", "adjust_supervision"]).parse(b.kind),
      note: b.note ? z.string().max(240).parse(b.note) : undefined,
    }),
  // --- Own-device companion telemetry + ESP32 hardware bridge ---------------
  device_activity_report: (d, u, b) =>
    pairing.reportOwnDeviceActivity(d, u, {
      device_id: b.device_id ? z.string().max(128).parse(b.device_id) : undefined,
      device_name: b.device_name ? z.string().max(80).parse(b.device_name) : undefined,
      platform: b.platform ? z.string().max(40).parse(b.platform) : undefined,
      screen_time_minutes: b.screen_time_minutes === undefined ? undefined : z.number().min(0).max(1440).parse(b.screen_time_minutes),
      apps: b.apps,
      hidden_apps: b.hidden_apps,
      browser_history: b.browser_history,
    }),
  device_activity_latest: (d, u) => pairing.getOwnDeviceActivity(d, u),
  esp32_pairing_create: (d, u, b) =>
    esp32.createEsp32Pairing(d, u, {
      label: b.label ? z.string().max(64).parse(b.label) : undefined,
      board: b.board ? z.string().max(32).parse(b.board) : undefined,
      capabilities: b.capabilities,
      family_id: b.family_id ? z.string().max(120).parse(b.family_id) : null,
    }),
  esp32_list: (d, u) => esp32.listEsp32Nodes(d, u),
  esp32_update: (d, u, b) =>
    esp32.updateEsp32Node(d, u, {
      id: z.string().min(1).max(128).parse(b.id),
      lamp: b.lamp === undefined ? undefined : z.number().min(0).max(255).parse(b.lamp),
      focus_mode: b.focus_mode === undefined ? undefined : z.boolean().parse(b.focus_mode),
      label: b.label === undefined ? undefined : z.string().max(64).parse(b.label),
    }),
  esp32_revoke: (d, u, b) => esp32.revokeEsp32Node(d, u, z.string().min(1).max(128).parse(b.id)),

  // --- Agent tasks & checkpoints (server-written execution trail) -------------
  agent_task_create: (d, u, b) =>
    agentTasks.createAgentTask(d, u, {
      title: z.string().min(1).max(120).parse(b.title),
      goal: z.string().min(1).max(4000).parse(b.goal),
      conversation_id: b.conversation_id ? str(b.conversation_id) : null,
      project_id: b.project_id ? str(b.project_id) : null,
      model: b.model ? str(b.model) : null,
    }),
  agent_task_list: (d, u) => agentTasks.listAgentTasks(d, u),
  agent_task_get: (d, u, b) => agentTasks.getAgentTask(d, u, z.string().min(1).parse(b.task_id)),
  agent_task_checkpoint: async () => {
    throw new RpcError("SERVER_WRITTEN", 403);
  },
  agent_task_status: async (d, u, b) => {
    const status = z.enum(["planning", "running", "awaiting_approval", "completed", "failed", "cancelled"]).parse(b.status);
    if (status !== "cancelled") throw new RpcError("SERVER_WRITTEN", 403);
    return agentTasks.cancelAgentTask(d, u, z.string().min(1).parse(b.task_id));
  },
  // --- Tool approvals (real one-time records, owner-decided) -----------------
  tool_approval_request: (d, u, b) => toolApprovals.requestToolApproval(d, u, { tool_id: z.string().min(3).max(64).parse(b.tool_id), args: b.args ?? {} }),
  tool_approval_decide: (d, u, b) => toolApprovals.decideToolApproval(d, u, z.string().min(1).max(120).parse(b.approval_id), z.boolean().parse(b.approve)),
  // --- Automations (actions only reference registry tools; LOW-risk only) -----
  automation_create: (d, u, b) =>
    automations.createAutomation(d, u, {
      name: z.string().min(2).max(80).parse(b.name),
      description: b.description ? str(b.description) : undefined,
      trigger: str(b.trigger),
      schedule: b.schedule ? str(b.schedule) : null,
      actions: b.actions,
      time: b.time ? str(b.time) : undefined,
      timezone: b.timezone ? str(b.timezone) : undefined,
    }),
  automation_list: (d, u) => automations.listAutomations(d, u),
  automation_scheduler_status: async (d) => {
    const snap = await d.collection("system_settings").doc("automation_worker").get();
    const value = snap.data()?.last_success_at;
    return { configured: (process.env.AUTOMATION_WORKER_SECRET?.trim().length ?? 0) >= 32, last_success_at: value?.toDate?.().toISOString() ?? null };
  },
  automation_runs_list: (d, u, b) => automations.listAutomationRuns(d, u, b.id ? z.string().max(128).parse(b.id) : undefined),
  automation_update: (d, u, b) => automations.updateAutomation(d, u, z.string().min(1).max(128).parse(b.id), { name: z.string().min(2).max(80).parse(b.name), description: str(b.description), trigger: str(b.trigger), schedule: b.schedule ? str(b.schedule) : null, actions: b.actions, time: b.time ? str(b.time) : undefined, timezone: b.timezone ? str(b.timezone) : undefined }),
  automation_status: (d, u, b) =>
    automations.setAutomationStatus(d, u, z.string().min(1).parse(b.id), z.enum(["active", "paused", "disabled"]).parse(b.status)),
  automation_delete: (d, u, b) => automations.deleteAutomation(d, u, z.string().min(1).parse(b.id)),
  automation_run: (d, u, b) =>
    automations.runAutomation(d, u, z.string().min(1).parse(b.id), { approvalId: b.approval_id ? str(b.approval_id) : undefined, triggerSource: str(b.source, "manual") }),

  agent_task_deploy: (d, u, b) =>
    agentDeploy.deployAgentTask(d, u, {
      task_id: z.string().min(1).parse(b.task_id),
      vercel_project_id: z.string().min(1).max(120).parse(b.vercel_project_id),
      approve: b.approve === true,
      target: b.target === "preview" ? "preview" : "production",
      subdomain: b.subdomain ? str(b.subdomain) : undefined,
    }),
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
      expected_revision: typeof b.expected_revision === "number" ? z.number().int().min(0).parse(b.expected_revision) : undefined,
    }),
  project_file_delete: (d, u, b) =>
    projects.deleteProjectFile(d, u, { project_id: z.string().min(1).parse(b.project_id), path: z.string().min(1).parse(b.path), expected_revision: typeof b.expected_revision === "number" ? z.number().int().min(0).parse(b.expected_revision) : undefined }),
  project_file_rename: (d, u, b) =>
    projects.renameProjectFile(d, u, { project_id: z.string().min(1).parse(b.project_id), from: z.string().min(1).parse(b.from), to: z.string().min(1).parse(b.to), expected_revision: typeof b.expected_revision === "number" ? z.number().int().min(0).parse(b.expected_revision) : undefined }),
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
      expected_revision: typeof b.expected_revision === "number" ? z.number().int().min(0).parse(b.expected_revision) : undefined,
    }),
  project_version_save: (d, u, b) =>
    projects.saveProjectVersion(d, u, { project_id: z.string().min(1).parse(b.project_id), source: str(b.source, "manual"), summary: str(b.summary) }),
  project_version_list: (d, u, b) => projects.listProjectVersions(d, u, z.string().min(1).parse(b.project_id)),
  project_version_restore: (d, u, b) =>
    projects.restoreProjectVersion(d, u, { project_id: z.string().min(1).parse(b.project_id), version_id: z.string().min(1).parse(b.version_id) }),
  project_set_env: (d, u, b) =>
    projects.setProjectEnv(d, u, { project_id: z.string().min(1).parse(b.project_id), env: z.record(z.string()).parse(b.env ?? {}) }),
  project_assets: (d, u, b) => projects.listProjectAssets(d, u, z.string().min(1).parse(b.project_id)),
  project_create_directory: (d, u, b) =>
    projects.createProjectDirectory(d, u, { project_id: z.string().min(1).parse(b.project_id), path: z.string().min(1).parse(b.path) }),
  project_publish: (d, u, b) =>
    deploy.publishProject(d, u, {
      project_id: z.string().min(1).parse(b.project_id),
      slug: b.slug ? str(b.slug) : undefined,
      overridden: bool(b.overridden),
    }),
  project_validate: (d, u, b) => deploy.validateProjectBuild(d, u, z.string().min(1).parse(b.project_id)),

  // --- build runs (real pipeline state, never synthesised) ------------------
  build_run_get: (d, u, b) => readBuildRun(d, u, z.string().min(1).parse(b.run_id)),
  build_run_latest: (d, u, b) => latestBuildRunForProject(d, u, z.string().min(1).parse(b.project_id)),

  // --- deployment panel (§17–§21) -------------------------------------------
  deployment_overview: (d, u, b) => deploy.getDeploymentOverview(d, u, z.string().min(1).parse(b.project_id)),
  deployment_logs: (d, u, b) =>
    deploy.deploymentLogs(d, u, {
      project_id: z.string().min(1).parse(b.project_id),
      deployment_id: b.deployment_id ? str(b.deployment_id) : undefined,
    }),
  deployment_rollback: (d, u, b) =>
    deploy.rollbackDeployment(d, u, {
      project_id: z.string().min(1).parse(b.project_id),
      deployment_id: z.string().min(1).parse(b.deployment_id),
    }),

  // --- project urls / aliases / custom domains (§8, §19, §20) ---------------
  url_list: (d, u, b) => deploy.listProjectUrls(d, u, z.string().min(1).parse(b.project_id)),
  url_add: (d, u, b) =>
    deploy.addProjectUrl(d, u, {
      project_id: z.string().min(1).parse(b.project_id),
      value: z.string().min(3).max(300).parse(b.value),
      kind: (b.kind === "custom" || b.kind === "preview" ? str(b.kind) : "generated") as "custom" | "preview" | "generated",
    }),
  url_remove: (d, u, b) =>
    deploy.removeProjectUrl(d, u, { project_id: z.string().min(1).parse(b.project_id), url_id: z.string().min(1).parse(b.url_id) }),
  url_set_primary: (d, u, b) =>
    deploy.setPrimaryProjectUrl(d, u, { project_id: z.string().min(1).parse(b.project_id), url_id: z.string().min(1).parse(b.url_id) }),
  url_verify_domain: (d, u, b) => deploy.verifyProjectDomain(d, u, z.string().min(1).parse(b.project_id)),
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
  admin_set_role: (d, u, b) =>
    rpc.adminSetUserRole(d, u, {
      uid: z.string().min(1).parse(b.uid),
      // Any string is accepted here; the canonical catalog in @/lib/roles is
      // the only authority on what is valid (and maps legacy values).
      role: z.string().min(1).parse(b.role),
    }),
  // Canonical role catalog — the admin UI selector is generated from this, so
  // it can never offer a role the backend would reject.
  admin_role_catalog: async (d, u) => {
    if (!(await rpc.isAdmin(d, u.uid))) throw new RpcError("PERMISSION_DENIED", 403);
    return {
      roles: ADMIN_ROLES.map((r) => ({
        id: r.id,
        label: r.label,
        description: r.description,
        tone: r.tone,
        permissions: [...r.permissions],
      })),
      permissions: [...ALL_ADMIN_PERMISSION_CODES],
      none: { id: NO_ROLE, label: "Standard user (no admin access)" },
    };
  },
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
  admin_ai_provider_get: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const config = await aiRuntime.getAIProviderConfigPublic(d);
    await rpc.logAudit(d, u.uid, "ai_provider_settings_viewed", "system_settings", "ai_provider", "");
    return config;
  },
  admin_ai_provider_save: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const result = await aiRuntime.saveAIProviderConfig(d, u.uid, {
      kind: b.kind === undefined ? undefined : z.enum(aiRuntime.MAIN_MODEL_KINDS).parse(b.kind),
      base_url: str(b.base_url),
      model: z.string().min(1).max(220).parse(b.model),
      agent_model: str(b.agent_model),
      vision_model: str(b.vision_model),
      api_key: typeof b.api_key === "string" ? b.api_key : "",
      enabled: bool(b.enabled, true),
      label: str(b.label, ""),
      allow_unverified: bool(b.allow_unverified, false),
    });
    await rpc.logAudit(d, u.uid, "ai_provider_settings_updated", "system_settings", "ai_provider", result.kind);
    return result;
  },
  admin_ai_provider_models: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const result = await aiRuntime.listAIProviderModels(d, {
      base_url: b.base_url === undefined ? "" : z.string().max(500).parse(b.base_url),
      api_key: z.string().max(4096).parse(b.api_key ?? ""),
      kind: b.kind === undefined ? undefined : z.enum(aiRuntime.MAIN_MODEL_KINDS).parse(b.kind),
    });
    await rpc.logAudit(d, u.uid, "ai_provider_model_catalog_loaded", "system_settings", "ai_provider", "");
    return result;
  },
  admin_ai_provider_test: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const mode = b?.mode === "agent" ? "agent" : b?.mode === "vision" ? "vision" : "general";
    const result = await aiRuntime.testAIProviderConfig(d, mode);
    await rpc.logAudit(d, u.uid, "ai_provider_settings_tested", "system_settings", "ai_provider", mode);
    return result;
  },
  admin_ai_managed_providers_get: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    await rpc.logAudit(d, u.uid, "ai_managed_provider_registry_viewed", "system_settings", "ai_managed_providers", "");
    return managedAI.getManagedProvidersPublic(d);
  },
  admin_ai_managed_models: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const kind = b.kind ? z.enum(["openai-compatible", "gemini", "anthropic"]).parse(b.kind) : undefined;
    const result = await managedAI.listManagedProviderModels(d, {
      provider_id: b.provider_id ? z.string().min(8).max(80).parse(b.provider_id) : undefined,
      kind,
      name: b.name ? z.string().max(80).parse(b.name) : undefined,
      base_url: b.base_url ? z.string().max(500).parse(b.base_url) : undefined,
      api_key: b.api_key ? z.string().max(4096).parse(b.api_key) : undefined,
    });
    await rpc.logAudit(d, u.uid, "ai_managed_provider_models_loaded", "system_settings", "ai_managed_providers", "");
    return result;
  },
  admin_ai_managed_provider_save: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const models = z.array(z.object({
      id: z.string().min(1).max(220),
      label: z.string().max(160),
      enabled: z.boolean(),
      use_for_chat: z.boolean(),
      use_for_agent: z.boolean(),
      use_for_vision: z.boolean(),
    })).min(1).max(50).parse(b.models);
    const saved = await managedAI.saveManagedProvider(d, u.uid, {
      id: b.id ? z.string().min(8).max(80).parse(b.id) : undefined,
      name: z.string().min(1).max(80).parse(b.name),
      kind: z.enum(["openai-compatible", "gemini", "anthropic"]).parse(b.kind),
      base_url: z.string().max(500).parse(b.base_url ?? ""),
      api_key: z.string().max(4096).parse(b.api_key ?? ""),
      enabled: bool(b.enabled),
      models,
      allow_unverified: bool(b.allow_unverified, false),
    });
    await rpc.logAudit(d, u.uid, "ai_managed_provider_saved", "system_settings", saved.id, "");
    return saved;
  },
  admin_ai_managed_provider_toggle: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const providerId = z.string().min(8).max(80).parse(b.id);
    const enabled = z.boolean().parse(b.enabled);
    const providers = await managedAI.setManagedProviderEnabled(d, providerId, enabled);
    await rpc.logAudit(d, u.uid, "ai_managed_provider_toggled", "system_settings", providerId, enabled ? "enabled" : "disabled");
    return providers;
  },
  admin_ai_managed_model_update: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const provider_id = z.string().min(8).max(80).parse(b.provider_id);
    const model_id = z.string().min(1).max(220).parse(b.model_id);
    const patch = {
      ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      ...(typeof b.use_for_chat === "boolean" ? { use_for_chat: b.use_for_chat } : {}),
      ...(typeof b.use_for_agent === "boolean" ? { use_for_agent: b.use_for_agent } : {}),
      ...(typeof b.use_for_vision === "boolean" ? { use_for_vision: b.use_for_vision } : {}),
    };
    if (!Object.keys(patch).length) throw new RpcError("BAD_REQUEST", 400);
    const providers = await managedAI.setManagedModelFlags(d, { provider_id, model_id, ...patch });
    await rpc.logAudit(d, u.uid, "ai_managed_model_updated", "system_settings", `${provider_id}:${model_id}`, "");
    return providers;
  },
  admin_ai_managed_provider_delete: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const providerId = z.string().min(8).max(80).parse(b.id);
    const providers = await managedAI.deleteManagedProvider(d, providerId);
    await rpc.logAudit(d, u.uid, "ai_managed_provider_deleted", "system_settings", providerId, "");
    return providers;
  },
  // --- image generation provider (Together AI + future providers) -------------
  // The API key is written encrypted and is NEVER returned to the browser:
  // these actions only ever expose {configured, provider, model, last4}.
  admin_image_provider_get: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    return imageConfig.getImageProviderConfigPublic(d);
  },
  admin_image_provider_save: async (d, u, b) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const apiKey = typeof b.api_key === "string" ? b.api_key : "";
    const result = await imageConfig.saveImageProviderConfig(d, u.uid, {
      provider: str(b.provider, "together"),
      model: str(b.model),
      api_key: apiKey,
      enabled: bool(b.enabled, true),
    });
    // Audit the CHANGE, never the secret. `key_rotated` records only whether a
    // new key was supplied — the value itself is never logged anywhere.
    await rpc.logAudit(d, u.uid, "image_provider_settings_updated", "system_settings", "image_provider", "", {
      provider: result.provider,
      model: result.model,
      enabled: result.enabled,
      key_rotated: apiKey.length > 0,
    });
    return result;
  },
  admin_image_provider_test: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const result = await imageConfig.testImageProviderConfig(d);
    await rpc.logAudit(d, u.uid, "image_provider_settings_tested", "system_settings", "image_provider", "", {
      ok: result.ok,
      code: result.code,
    });
    return result;
  },
  admin_image_provider_clear_key: async (d, u) => {
    if (!(await rpc.hasPermission(d, u.uid, "system.settings"))) throw new RpcError("PERMISSION_DENIED", 403);
    const result = await imageConfig.clearImageProviderKey(d, u.uid);
    await rpc.logAudit(d, u.uid, "image_provider_key_cleared", "system_settings", "image_provider", "");
    return result;
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
  // Incremental upward scroll: the chat page ships only the most recent
  // messages, and asks for older pages as the user scrolls back.
  conversation_messages_page: async (d, u, b) => {
    const id = z.string().min(1).parse(b.id);
    const before = str(b.before);
    const limit = Math.min(50, Math.max(10, Number(b.limit) || 30));
    const page = await getConversationHistoryPage(d, u.uid, id, before, limit);
    if (!page) throw new RpcError("NOT_FOUND", 404);
    return page;
  },
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
    if (typeof b.avatar_url === "string") {
      const url = b.avatar_url.trim();
      if (url && !isAllowedAvatarUrl(url)) throw new RpcError("AVATAR_INVALID", 400);
      patch.avatar_url = url.slice(0, 180_000);
    }
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
    return snap.docs.map((a) => ({ id: a.id, actor_id: a.data().actor_id ?? "", action: a.data().action, target_type: a.data().target_type ?? "", target_id: a.data().target_id ?? "", reason: a.data().reason ?? "", metadata: (a.data().metadata ?? {}) as Record<string, unknown>, created_at: a.data().created_at?.toDate?.().toISOString() ?? "" }));
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
