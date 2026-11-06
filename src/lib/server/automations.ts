// =============================================================================
// MATRIX AI — Automations backend (server-only). Create/pause/delete are RPC
// mutations; execution ALWAYS goes through the unified tool gateway so every
// automated action is authorized, risk-checked and audited. Automations may
// only auto-run LOW-risk tools — anything riskier needs an approval id per run.
// =============================================================================

import "server-only";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";
import { hasPermission } from "@/lib/server/rpc";
import {
  MAX_AUTOMATION_NAME,
  validateAutomationActions,
  isAutomationTrigger,
  isSchedulePreset,
  type Automation,
  type AutomationAction,
} from "@/lib/automations";
import { RiskTier, toolRegistry, type ToolContext, type ToolResult } from "@/lib/ai/tools/registry";
import "@/lib/ai/tools/index";

export { RpcError };

const AUTOMATIONS = "automations";
const RUNS = "automation_runs";

export async function createAutomation(
  d: Db,
  user: SessionUser,
  input: { name: string; description?: string; trigger: string; schedule?: string | null; actions: unknown },
): Promise<Automation> {
  const name = input.name.trim().slice(0, MAX_AUTOMATION_NAME);
  if (name.length < 2) throw new RpcError("NAME_INVALID");
  if (!isAutomationTrigger(input.trigger)) throw new RpcError("TRIGGER_INVALID");
  const schedule = input.trigger === "schedule" ? (isSchedulePreset(input.schedule) ? input.schedule : null) : null;
  if (input.trigger === "schedule" && !schedule) throw new RpcError("SCHEDULE_REQUIRED");
  const actions = validateAutomationActions(input.actions);
  // Server-side check: every action's tool must exist, and only LOW-risk
  // tools may be attached to an automation (higher risk needs per-run approval).
  for (const action of actions) {
    const spec = toolRegistry.get(action.tool);
    if (!spec) throw new RpcError(`UNKNOWN_TOOL: ${action.tool}`, 400);
    if (spec.risk !== RiskTier.LOW) throw new RpcError(`TOOL_RISK_TOO_HIGH_FOR_AUTOMATION: ${action.tool}`, 400);
    try {
      toolRegistry.validateArgs(action.tool, action.args ?? {});
    } catch {
      throw new RpcError(`ACTION_ARGS_INVALID: ${action.tool}`, 400);
    }
  }
  const ref = d.collection(AUTOMATIONS).doc();
  const now = nowTs();
  await ref.set({
    user_id: user.uid,
    name,
    description: (input.description ?? "").slice(0, 300),
    trigger: input.trigger,
    schedule,
    actions,
    status: "active",
    last_run_at: null,
    last_run_ok: null,
    run_count: 0,
    created_at: now,
    updated_at: now,
  });
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: "automation.create",
    target_type: "automation",
    target_id: ref.id,
    reason: name,
    metadata: { actions: actions.map((a) => a.tool) },
    created_at: now,
  });
  return (await ref.get()).data() as Automation;
}

async function requireOwned(d: Db, user: SessionUser, id: string) {
  const snap = await d.collection(AUTOMATIONS).doc(id).get();
  if (!snap.exists || snap.data()?.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  return snap.ref;
}

export async function listAutomations(d: Db, user: SessionUser): Promise<Automation[]> {
  const snap = await d.collection(AUTOMATIONS).where("user_id", "==", user.uid).get();
  return snap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        user_id: String(data.user_id ?? ""),
        name: String(data.name ?? ""),
        description: String(data.description ?? ""),
        trigger: String(data.trigger ?? "manual"),
        schedule: (data.schedule as Automation["schedule"]) ?? null,
        actions: (data.actions as AutomationAction[]) ?? [],
        status: String(data.status ?? "active"),
        last_run_at: data.last_run_at ? data.last_run_at.toDate().toISOString() : null,
        last_run_ok: typeof data.last_run_ok === "boolean" ? data.last_run_ok : null,
        run_count: Number(data.run_count ?? 0),
        created_at: data.created_at?.toDate?.().toISOString() ?? "",
        updated_at: data.updated_at?.toDate?.().toISOString() ?? "",
      } as Automation;
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function setAutomationStatus(d: Db, user: SessionUser, id: string, status: "active" | "paused" | "disabled") {
  const ref = await requireOwned(d, user, id);
  await ref.set({ status, updated_at: nowTs() }, { merge: true });
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: `automation.${status}`,
    target_type: "automation",
    target_id: id,
    reason: "",
    metadata: {},
    created_at: nowTs(),
  });
  return true;
}

export async function deleteAutomation(d: Db, user: SessionUser, id: string) {
  await requireOwned(d, user, id);
  await d.collection(AUTOMATIONS).doc(id).set({ status: "disabled", deleted_at: nowTs(), updated_at: nowTs() }, { merge: true });
  return true;
}

export type AutomationRunResult = { ok: boolean; results: Array<ToolResult & { tool: string }>; run_id: string };

/**
 * Execute one automation now. Each action runs through the registry's guarded
 * call path (authorize → validate → timeout). The run is recorded with its
 * real per-action outcomes.
 */
export async function runAutomation(
  d: Db,
  user: SessionUser,
  id: string,
  opts: { approvalId?: string; triggerSource?: string } = {},
): Promise<AutomationRunResult> {
  const ref = await requireOwned(d, user, id);
  const snap = await ref.get();
  const data = snap.data()!;
  if (data.status === "disabled" || data.deleted_at) throw new RpcError("AUTOMATION_DISABLED", 409);
  const actions = (data.actions as AutomationAction[]) ?? [];
  const requestId = `auto_${Date.now().toString(36)}`;
  const results: Array<ToolResult & { tool: string }> = [];
  for (const action of actions) {
    const ctx: ToolContext = { db: d, uid: user.uid, email: user.email, requestId, approvalId: opts.approvalId };
    const authorizer = async (c: ToolContext, permissions: readonly string[]) => {
      for (const p of permissions) if (!(await hasPermission(d, c.uid, p))) return false;
      return true;
    };
    const res = await toolRegistry.call(ctx, action.tool, action.args ?? {}, authorizer);
    results.push({ ...res, tool: action.tool });
  }
  const ok = results.every((r) => r.ok);
  const runRef = d.collection(RUNS).doc();
  await runRef.set({
    automation_id: id,
    user_id: user.uid,
    triggered_by: opts.triggerSource ?? "manual",
    ok,
    results: results.map((r) => ({ tool: r.tool, ok: r.ok, error: r.error ?? null })),
    request_id: requestId,
    created_at: nowTs(),
  });
  await ref.set({ last_run_at: nowTs(), last_run_ok: ok, run_count: Number(data.run_count ?? 0) + 1, updated_at: nowTs() }, { merge: true });
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: ok ? "automation.run" : "automation.run_failed",
    target_type: "automation",
    target_id: id,
    reason: `${results.length} action(s), ok=${ok}`,
    metadata: { run_id: runRef.id },
    created_at: nowTs(),
  });
  return { ok, results, run_id: runRef.id };
}
