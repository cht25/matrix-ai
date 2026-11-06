// =============================================================================
// MATRIX AI — Automations: shared model (client-safe, no server imports).
//
// An automation = trigger + ordered actions. Actions reference REGISTERED
// tool ids from the unified tool registry; execution always goes through the
// guarded gateway (authorize → validate → audit). Only LOW-risk tools may run
// automatically; anything riskier requires an explicit approval per run.
// =============================================================================

export const AUTOMATION_TRIGGERS = ["schedule", "event", "manual"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const SCHEDULE_PRESETS = ["hourly", "daily", "weekly"] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

export const AUTOMATION_STATUSES = ["active", "paused", "disabled"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export type AutomationAction = {
  tool: string; // registry tool id
  args?: Record<string, unknown>;
};

export type Automation = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  trigger: AutomationTrigger;
  schedule: SchedulePreset | null;
  actions: AutomationAction[];
  status: AutomationStatus;
  last_run_at: string | null;
  last_run_ok: boolean | null;
  run_count: number;
  created_at: string;
  updated_at: string;
};

export function isAutomationTrigger(value: unknown): value is AutomationTrigger {
  return typeof value === "string" && (AUTOMATION_TRIGGERS as readonly string[]).includes(value);
}
export function isSchedulePreset(value: unknown): value is SchedulePreset {
  return typeof value === "string" && (SCHEDULE_PRESETS as readonly string[]).includes(value);
}
export function isAutomationStatus(value: unknown): value is AutomationStatus {
  return typeof value === "string" && (AUTOMATION_STATUSES as readonly string[]).includes(value);
}

export const MAX_AUTOMATION_ACTIONS = 5;
export const MAX_AUTOMATION_NAME = 80;

/** Validate the action list shape (tool ids are checked against the registry server-side). */
export function validateAutomationActions(actions: unknown): AutomationAction[] {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error("ACTIONS_REQUIRED");
  if (actions.length > MAX_AUTOMATION_ACTIONS) throw new Error("TOO_MANY_ACTIONS");
  return actions.map((a) => {
    if (typeof a !== "object" || a === null) throw new Error("ACTION_INVALID");
    const tool = (a as Record<string, unknown>).tool;
    if (typeof tool !== "string" || !/^[a-z][a-z0-9_.]{2,63}$/.test(tool)) throw new Error("ACTION_TOOL_INVALID");
    const args = (a as Record<string, unknown>).args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) throw new Error("ACTION_ARGS_INVALID");
    return { tool, args: (args as Record<string, unknown>) ?? {} };
  });
}
