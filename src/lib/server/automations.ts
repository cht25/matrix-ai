import "server-only";
import crypto from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { adminAuth, nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { MAX_AUTOMATION_NAME, validateAutomationActions, isAutomationTrigger, isSchedulePreset, type Automation, type AutomationAction } from "@/lib/automations";
import { nextAutomationRun, validTimezone } from "@/lib/automation-schedule";
import { RiskTier, toolRegistry, type ToolResult } from "@/lib/ai/tools/registry";
import { executeAgentTool } from "@/lib/server/tool-gateway";
import "@/lib/ai/tools/index";

export { RpcError };
const AUTOMATIONS = "automations";
const RUNS = "automation_runs";
const LEASE_MS = 120_000;
const iso = (value: unknown) => (value as { toDate?: () => Date })?.toDate?.().toISOString() ?? (typeof value === "string" ? value : "");

type Definition = { name: string; description?: string; trigger: string; schedule?: string | null; actions: unknown; time?: string; timezone?: string };
function validateDefinition(input: Definition) {
  const name = input.name.trim().slice(0, MAX_AUTOMATION_NAME);
  if (name.length < 2) throw new RpcError("NAME_INVALID");
  if (!isAutomationTrigger(input.trigger)) throw new RpcError("TRIGGER_INVALID");
  const schedule = input.trigger === "schedule" ? (isSchedulePreset(input.schedule) ? input.schedule : null) : null;
  if (input.trigger === "schedule" && !schedule) throw new RpcError("SCHEDULE_REQUIRED");
  const time = input.time ?? "07:00";
  const timezone = input.timezone ?? "UTC";
  if (schedule && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !validTimezone(timezone))) throw new RpcError("SCHEDULE_INVALID");
  const actions = validateAutomationActions(input.actions);
  let totalTimeout = 0;
  for (const action of actions) {
    const spec = toolRegistry.get(action.tool);
    if (!spec) throw new RpcError(`UNKNOWN_TOOL: ${action.tool}`, 400);
    if (spec.risk !== RiskTier.LOW || spec.approvalRequired) throw new RpcError(`TOOL_RISK_TOO_HIGH_FOR_AUTOMATION: ${action.tool}`, 400);
    totalTimeout += spec.timeoutSeconds;
    try { toolRegistry.validateArgs(action.tool, action.args ?? {}); }
    catch { throw new RpcError(`ACTION_ARGS_INVALID: ${action.tool}`, 400); }
  }
  if (totalTimeout > 90) throw new RpcError("AUTOMATION_TIMEOUT_BUDGET_EXCEEDED");
  return { name, description: (input.description ?? "").slice(0, 300), trigger: input.trigger, schedule, time, timezone, actions };
}
function nextDue(data: Record<string, unknown>, after: number): Timestamp | null {
  if (data.trigger !== "schedule" || !isSchedulePreset(data.schedule)) return null;
  try {
    return Timestamp.fromMillis(nextAutomationRun({ preset: data.schedule, time: String(data.time ?? "07:00"), timezone: String(data.timezone ?? "UTC"), weekday: Number(data.schedule_weekday ?? new Date(iso(data.created_at) || after).getUTCDay()), after }));
  } catch { throw new RpcError("SCHEDULE_INVALID"); }
}
function serialize(id: string, data: Record<string, unknown>): Automation {
  return { id, user_id: String(data.user_id ?? ""), name: String(data.name ?? ""), description: String(data.description ?? ""), trigger: String(data.trigger ?? "manual") as Automation["trigger"], schedule: (data.schedule as Automation["schedule"]) ?? null, actions: (data.actions as AutomationAction[]) ?? [], status: String(data.status ?? "active") as Automation["status"], last_run_at: iso(data.last_run_at) || null, last_run_ok: typeof data.last_run_ok === "boolean" ? data.last_run_ok : null, run_count: Number(data.run_count ?? 0), created_at: iso(data.created_at), updated_at: iso(data.updated_at), time: String(data.time ?? "07:00"), timezone: String(data.timezone ?? "UTC"), next_run_at: iso(data.next_run_at) || null };
}
export async function createAutomation(d: Db, user: SessionUser, input: Definition): Promise<Automation> {
  const definition = validateDefinition(input);
  const ref = d.collection(AUTOMATIONS).doc();
  const now = nowTs();
  const data = { ...definition, user_id: user.uid, status: "active", last_run_at: null, last_run_ok: null, run_count: 0, schedule_weekday: new Date().getUTCDay(), created_at: now, updated_at: now, next_run_at: nextDue(definition, Date.now()) };
  await ref.set(data);
  await d.collection("audit_logs").add({ actor_id: user.uid, action: "automation.create", target_type: "automation", target_id: ref.id, reason: definition.name, metadata: { actions: definition.actions.map((a) => a.tool) }, created_at: now });
  return serialize(ref.id, data);
}
async function requireOwned(d: Db, user: SessionUser, id: string) {
  const snap = await d.collection(AUTOMATIONS).doc(id).get();
  if (!snap.exists || snap.data()?.user_id !== user.uid || snap.data()?.deleted_at) throw new RpcError("NOT_FOUND", 404);
  return snap.ref;
}
export async function updateAutomation(d: Db, user: SessionUser, id: string, input: Definition) {
  const ref = await requireOwned(d, user, id);
  const definition = validateDefinition(input);
  await ref.set({ ...definition, next_run_at: nextDue(definition, Date.now()), updated_at: nowTs() }, { merge: true });
  await d.collection("audit_logs").add({ actor_id: user.uid, action: "automation.update", target_type: "automation", target_id: id, reason: definition.name, metadata: {}, created_at: nowTs() });
  return true;
}
export async function listAutomations(d: Db, user: SessionUser): Promise<Automation[]> {
  const snap = await d.collection(AUTOMATIONS).where("user_id", "==", user.uid).get();
  return snap.docs.filter((doc) => !doc.data().deleted_at).map((doc) => serialize(doc.id, doc.data())).sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export async function setAutomationStatus(d: Db, user: SessionUser, id: string, status: "active" | "paused" | "disabled") {
  const ref = await requireOwned(d, user, id);
  const snap = await ref.get();
  await ref.set({ status, updated_at: nowTs(), ...(status === "active" ? { next_run_at: nextDue(snap.data()!, Date.now()) } : {}) }, { merge: true });
  await d.collection("audit_logs").add({ actor_id: user.uid, action: `automation.${status}`, target_type: "automation", target_id: id, reason: "", metadata: {}, created_at: nowTs() });
  return true;
}
export async function deleteAutomation(d: Db, user: SessionUser, id: string) {
  await requireOwned(d, user, id);
  await d.collection(AUTOMATIONS).doc(id).set({ status: "disabled", deleted_at: nowTs(), updated_at: nowTs(), next_run_at: null }, { merge: true });
  return true;
}
export type AutomationRunResult = { ok: boolean; results: Array<ToolResult & { tool: string }>; run_id: string };

/** Transactional claim prevents duplicate scheduled/manual execution across instances. */
export async function runAutomation(d: Db, user: SessionUser, id: string, opts: { approvalId?: string; triggerSource?: string; scheduled?: boolean; nowMs?: number } = {}): Promise<AutomationRunResult> {
  const ref = d.collection(AUTOMATIONS).doc(id);
  const nowMs = opts.nowMs ?? Date.now();
  const leaseToken = crypto.randomUUID();
  let data: Record<string, unknown> = {};
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    data = snap.data() ?? {};
    if (!snap.exists || data.user_id !== user.uid || data.deleted_at) throw new RpcError("NOT_FOUND", 404);
    if (data.status === "disabled" || (opts.scheduled && data.status !== "active")) throw new RpcError("AUTOMATION_DISABLED", 409);
    const leaseUntil = (data.lease_until as Timestamp | undefined)?.toMillis?.() ?? 0;
    if (leaseUntil > nowMs) throw new RpcError("AUTOMATION_ALREADY_RUNNING", 409);
    if (opts.scheduled) {
      const due = (data.next_run_at as Timestamp | undefined)?.toMillis?.() ?? Infinity;
      if (data.trigger !== "schedule" || due > nowMs) throw new RpcError("AUTOMATION_NOT_DUE", 409);
    }
    tx.set(ref, { lease_until: Timestamp.fromMillis(nowMs + LEASE_MS), lease_token: leaseToken, ...(opts.scheduled ? { next_run_at: nextDue(data, nowMs) } : {}) }, { merge: true });
  });
  const actions = (data.actions as AutomationAction[]) ?? [];
  const requestId = `auto_${leaseToken}`;
  const runRef = d.collection(RUNS).doc();
  const results: Array<ToolResult & { tool: string }> = [];
  await runRef.set({ automation_id: id, user_id: user.uid, triggered_by: opts.scheduled ? "scheduler" : opts.triggerSource ?? "manual", status: "running", ok: false, results: [], request_id: requestId, created_at: nowTs() });
  let ok = false;
  try {
    for (const action of actions) {
      const result = await executeAgentTool(d, user, action.tool, action.args ?? {}, { approvalId: opts.approvalId });
      results.push({ ...result, tool: action.tool });
      await runRef.set({ results: results.map(historyResult), updated_at: nowTs() }, { merge: true });
      if (!result.ok) break;
    }
    ok = results.length === actions.length && results.every((result) => result.ok);
    await runRef.set({ status: ok ? "completed" : "failed", ok, results: results.map(historyResult), finished_at: nowTs() }, { merge: true });
    await d.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.data()?.lease_token !== leaseToken) return;
      tx.set(ref, { last_run_at: nowTs(), last_run_ok: ok, run_count: Number(current.data()?.run_count ?? 0) + 1, lease_until: null, lease_token: null, updated_at: nowTs() }, { merge: true });
    });
    await d.collection("audit_logs").add({ actor_id: user.uid, action: ok ? "automation.run" : "automation.run_failed", target_type: "automation", target_id: id, reason: `${results.length} action(s), ok=${ok}`, metadata: { run_id: runRef.id }, created_at: nowTs() });
    return { ok, results, run_id: runRef.id };
  } catch (error) {
    await runRef.set({ status: "failed", ok: false, error: "EXECUTION_FAILED", results: results.map(historyResult), finished_at: nowTs() }, { merge: true }).catch(() => {});
    await ref.set({ lease_until: null, lease_token: null, last_run_at: nowTs(), last_run_ok: false }, { merge: true }).catch(() => {});
    throw error;
  }
}
function historyResult(result: ToolResult & { tool: string }) {
  return { tool: result.tool, ok: result.ok, error: result.error ?? null, message: result.message ?? "", data: JSON.stringify(result.data ?? null).slice(0, 10000) };
}
export async function listAutomationRuns(d: Db, user: SessionUser, automationId?: string) {
  const snap = await d.collection(RUNS).where("user_id", "==", user.uid).get();
  return snap.docs.filter((doc) => !automationId || doc.data().automation_id === automationId).map((doc) => ({ id: doc.id, automation_id: doc.data().automation_id, status: doc.data().status ?? (doc.data().ok ? "completed" : "failed"), ok: doc.data().ok === true, triggered_by: doc.data().triggered_by ?? "manual", results: doc.data().results ?? [], error: doc.data().error ?? null, created_at: iso(doc.data().created_at) })).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
}

/** Worker batch. Each candidate is revalidated and claimed transactionally. */
export async function runDueAutomations(d: Db, opts: { nowMs?: number; limit?: number; resolveUser?: (uid: string) => Promise<SessionUser> } = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const snap = await d.collection(AUTOMATIONS).where("next_run_at", "<=", Timestamp.fromMillis(nowMs)).limit(Math.min(20, Math.max(1, opts.limit ?? 10))).get();
  const resolveUser = opts.resolveUser ?? (async (uid) => { const user = await adminAuth().getUser(uid); if (user.disabled) throw new RpcError("ACCOUNT_DISABLED", 403); return { uid, email: user.email ?? null, emailVerified: user.emailVerified }; });
  const outcomes: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.status !== "active" || data.trigger !== "schedule" || data.deleted_at) continue;
    try {
      const user = await resolveUser(String(data.user_id));
      if (user.uid !== data.user_id) throw new RpcError("IDENTITY_MISMATCH", 403);
      const result = await runAutomation(d, user, doc.id, { scheduled: true, nowMs, triggerSource: "scheduler" });
      outcomes.push({ id: doc.id, ok: result.ok });
    } catch (error) {
      outcomes.push({ id: doc.id, ok: false, error: error instanceof RpcError ? error.code : "EXECUTION_FAILED" });
    }
  }
  return { checked_at: new Date(nowMs).toISOString(), attempted: outcomes.length, succeeded: outcomes.filter((item) => item.ok).length, outcomes };
}
