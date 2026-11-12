"use client";

// MATRIX Automations — triggers → ordered real tool actions.
//
// Redesigned for people, not for JSON authors:
//   · a preset gallery starts a useful workflow in one click;
//   · every action is a form generated from the tool's own inputs, so nobody
//     has to hand-write an argument object (advanced JSON stays available);
//   · the flow is drawn trigger → action → action with add/remove/reorder;
//   · status, next run, last result and execution history are visible at a
//     glance, and every run leaves a verifiable trail.
//
// Only LOW-risk registered tools can run automatically; anything else needs an
// explicit approval per run, and that rule is enforced server-side.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, CheckCircle2, Clock, History, Loader2, Pause, Play, Plus, RefreshCw,
  Save, Sparkles, Trash2, XCircle, Zap,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { Modal, ConfirmModal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { notifyWorkDone } from "@/lib/client/work-notifications";
import { cn } from "@/lib/utils";

type ToolInfo = { id: string; description: string; risk: string; approvalRequired: boolean; input?: Record<string, unknown> };
type Action = { tool: string; args?: Record<string, unknown> };
type Automation = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  schedule: string | null;
  actions: Action[];
  status: string;
  run_count: number;
  last_run_ok: boolean | null;
  last_run_at: string | null;
  time?: string;
  timezone?: string;
  next_run_at?: string | null;
};
type Step = { tool: string; argsText: string };
type Run = {
  id: string;
  automation_id: string;
  status: string;
  ok: boolean;
  triggered_by: string;
  created_at: string;
  error?: string;
  results: { tool: string; ok: boolean; error?: string; message?: string; data?: string }[];
};
type Scheduler = { configured: boolean; last_success_at: string | null };

/** Friendly, typed fields for the tools this product actually ships. */
type FieldSpec = { key: string; label: string; placeholder: string; multiline?: boolean; required?: boolean; hint?: string };

const TOOL_FORM: Record<string, FieldSpec[]> = {
  "notifications.create": [
    { key: "title", label: "Notification title", placeholder: "Morning check-in", required: true },
    { key: "body", label: "Message", placeholder: "Your workflow ran successfully.", multiline: true, required: true },
    { key: "link", label: "Where it should open", placeholder: "/automations", hint: "Any in-app path, e.g. /projects" },
  ],
  "projects.get": [{ key: "project_id", label: "Project ID", placeholder: "paste a project id", required: true }],
  "deployments.latest_for_project": [{ key: "project_id", label: "Project ID", placeholder: "paste a project id", required: true }],
};

const TOOL_LABEL: Record<string, string> = {
  "notifications.create": "Send me a notification",
  "projects.list": "Look at my projects",
  "projects.get": "Open one project",
  "github.connection_status": "Check my GitHub connection",
  "github.list_repos": "List my GitHub repositories",
  "deployments.latest_for_project": "Check the latest deployment",
  "devices.list": "Check my devices",
  "family.list": "Check my family",
};

const PRESETS: Array<{ name: string; description: string; trigger: string; schedule?: string; time?: string; steps: Array<{ tool: string; args: Record<string, unknown> }> }> = [
  {
    name: "Morning check-in",
    description: "Every morning at 07:00, look at my projects and send a notification when it is done.",
    trigger: "schedule",
    schedule: "daily",
    time: "07:00",
    steps: [
      { tool: "projects.list", args: {} },
      { tool: "notifications.create", args: { title: "Good morning", body: "Your projects were checked. Open MATRIX to see what needs attention.", link: "/projects" } },
    ],
  },
  {
    name: "Weekly deployment check",
    description: "Once a week, report what the latest deployment state is.",
    trigger: "schedule",
    schedule: "weekly",
    time: "18:00",
    steps: [{ tool: "deployments.latest_for_project", args: { project_id: "" } }],
  },
  {
    name: "Connection self-test",
    description: "A manual workflow that proves the whole chain works: list projects, then notify me.",
    trigger: "manual",
    steps: [
      { tool: "projects.list", args: {} },
      { tool: "notifications.create", args: { title: "Automation check-in", body: "Manual run completed.", link: "/automations" } },
    ],
  },
  {
    name: "Devices & family digest",
    description: "Daily status check of your paired devices and family household, followed by an alert.",
    trigger: "schedule",
    schedule: "daily",
    time: "20:00",
    steps: [
      { tool: "devices.list", args: {} },
      { tool: "notifications.create", args: { title: "Evening device check", body: "Devices were checked. Review activity on Devices or Family.", link: "/devices" } },
    ],
  },
];

const blankStep = (): Step => ({ tool: "", argsText: "{}" });

function parseArgs(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof RpcCallError) {
    const map: Record<string, string> = {
      NOT_FOUND: "The workflow no longer exists. Refresh the page.",
      AUTOMATION_NOT_DUE: "This workflow is not due yet. Use Run now for an immediate manual run.",
      APPROVAL_REQUIRED: "One of the actions needs explicit approval. Remove it or approve it from the Agent tools panel.",
      TOOL_NOT_ALLOWED: "Only registered low-risk tools can run automatically.",
      SCHEDULE_INVALID: "Enter a valid time and timezone.",
      TRIGGER_INVALID: "Choose a valid trigger.",
      ACTION_TOOL_INVALID: "Choose a tool for every action.",
      BAD_REQUEST: "Some step details are not valid. Check the arguments.",
    };
    return map[err.code] ?? err.code.replace(/_/g, " ").toLowerCase();
  }
  return fallback;
}

function relative(iso?: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `in ${Math.floor(ms / 60_000)}m`.replace("in -", "");
  if (ms < 0) return new Date(iso).toLocaleString();
  return new Date(iso).toLocaleString();
}

export function AutomationsClient() {
  const toast = useToast();
  const [items, setItems] = useState<Automation[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [scheduler, setScheduler] = useState<Scheduler>({ configured: false, last_success_at: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectsList, setProjectsList] = useState<Array<{ id: string; name: string }>>([]);
  const [trigger, setTrigger] = useState("manual");
  const [schedule, setSchedule] = useState("daily");
  const [time, setTime] = useState("07:00");
  const [timezone, setTimezone] = useState("UTC");
  const [steps, setSteps] = useState<Step[]>([blankStep()]);
  const [advanced, setAdvanced] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Automation | null>(null);

  const timezones = useMemo(() => {
    const zone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
    return Array.from(new Set(["UTC", zone, "Asia/Dhaka", "Asia/Kolkata", "Europe/London", "America/New_York", "Asia/Tokyo", "Australia/Sydney"].filter(Boolean)));
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, toolResponse, history, status, projs] = await Promise.all([
        rpc<Automation[]>("automation_list"),
        fetch("/api/agent/tools", { credentials: "same-origin" }).then(async (response) => {
          if (!response.ok) throw new Error("TOOLS_UNAVAILABLE");
          return response.json() as Promise<{ tools: ToolInfo[] }>;
        }),
        rpc<Run[]>("automation_runs_list"),
        rpc<Scheduler>("automation_scheduler_status"),
        rpc<Array<{ id: string; name: string }>>("project_list").catch(() => []),
      ]);
      setItems(list);
      setTools(toolResponse.tools.filter((tool) => tool.risk === "low" && !tool.approvalRequired));
      setRuns(history);
      setScheduler(status);
      setProjectsList(projs);
      setError("");
    } catch {
      setError("Could not load automations. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function reset() {
    setEditing("");
    setName("");
    setDescription("");
    setTrigger("manual");
    setSchedule("daily");
    setTime("07:00");
    setTimezone(timezones[0] ?? "UTC");
    setSteps([blankStep()]);
    setAdvanced(null);
    setNotice("");
  }

  function openNew() { reset(); setEditorOpen(true); }

  function openPreset(preset: typeof PRESETS[number]) {
    setEditing("");
    setName(preset.name);
    setDescription(preset.description);
    setTrigger(preset.trigger);
    setSchedule(preset.schedule ?? "daily");
    setTime(preset.time ?? "07:00");
    setTimezone(timezones[0] ?? "UTC");
    setSteps(preset.steps.map((step) => ({ tool: step.tool, argsText: JSON.stringify(step.args, null, 2) })));
    setAdvanced(null);
    setNotice("");
    setTemplatesOpen(false);
    setEditorOpen(true);
  }

  function edit(item: Automation) {
    setEditing(item.id);
    setName(item.name);
    setDescription(item.description || "");
    setTrigger(item.trigger);
    setSchedule(item.schedule ?? "daily");
    setTime(item.time ?? "07:00");
    setTimezone(item.timezone ?? "UTC");
    setSteps(item.actions.map((action) => ({ tool: action.tool, argsText: JSON.stringify(action.args ?? {}, null, 2) })));
    setAdvanced(null);
    setNotice("");
    setEditorOpen(true);
  }

  function patchStep(index: number, patch: Partial<Step>) {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  function patchArg(index: number, key: string, value: string) {
    setSteps((current) => current.map((step, i) => {
      if (i !== index) return step;
      const args = parseArgs(step.argsText) ?? {};
      return { ...step, argsText: JSON.stringify({ ...args, [key]: value }, null, 2) };
    }));
  }

  function stepArgs(index: number): Record<string, unknown> {
    return parseArgs(steps[index]?.argsText ?? "{}") ?? {};
  }

  function move(index: number, direction: number) {
    setSteps((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    setError("");
    setNotice("");
    let actions: Action[];
    try {
      actions = steps.map((step) => {
        const args = JSON.parse(step.argsText);
        if (!step.tool || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid");
        return { tool: step.tool, args };
      });
    } catch {
      setError("Every action needs a tool, and its arguments must be a valid JSON object.");
      return;
    }
    setBusy("save");
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        trigger,
        schedule: trigger === "schedule" ? schedule : null,
        time,
        timezone,
        actions,
      };
      await rpc(editing ? "automation_update" : "automation_create", editing ? { id: editing, ...payload } : payload);
      toast(editing ? "Workflow updated." : "Workflow created.");
      setEditorOpen(false);
      reset();
      await load();
    } catch (err) {
      setError(friendlyError(err, "Could not save this workflow."));
    } finally {
      setBusy("");
    }
  }

  async function runNow(item: Automation) {
    setBusy(`run-${item.id}`);
    try {
      const result = await rpc<{ ok: boolean }>("automation_run", { id: item.id });
      toast(result.ok ? "Workflow ran successfully." : "Workflow ran, but one action failed. Open history for details.");
      void notifyWorkDone({
        title: result.ok ? `Workflow finished: ${item.name}` : `Workflow issue: ${item.name}`,
        body: result.ok ? "All steps completed." : "One or more actions failed — check Execution history.",
        link: "/automations",
      });
      await load();
    } catch (err) {
      setError(friendlyError(err, "The manual run did not complete."));
    } finally {
      setBusy("");
    }
  }

  async function toggleStatus(item: Automation) {
    setBusy(`status-${item.id}`);
    try {
      await rpc("automation_status", { id: item.id, status: item.status === "active" ? "paused" : "active" });
      toast(item.status === "active" ? "Workflow paused." : "Workflow activated.");
      await load();
    } catch (err) {
      setError(friendlyError(err, "Could not change the workflow status."));
    } finally {
      setBusy("");
    }
  }

  async function remove(item: Automation) {
    setBusy(`delete-${item.id}`);
    try {
      await rpc("automation_delete", { id: item.id });
      toast("Workflow removed. Run history is retained.");
      await load();
    } catch (err) {
      setError(friendlyError(err, "Could not remove the workflow."));
    } finally {
      setBusy("");
    }
  }

  const activeCount = items.filter((item) => item.status === "active").length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Automation / control</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Automations</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            Connect a trigger to real, authorized actions. Every run is recorded, and only low-risk tools can run without you.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()}><RefreshCw size={15} /> Refresh</Button>
          <Button variant="secondary" onClick={() => setTemplatesOpen((v) => !v)}><Sparkles size={15} /> Templates</Button>
          <Button onClick={openNew}><Plus size={15} /> New workflow</Button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="flex items-center gap-3">
          <Zap size={18} className="text-accent" />
          <div><p className="text-xs text-ink-3">Active workflows</p><p className="text-lg font-semibold text-ink">{activeCount}</p></div>
        </Card>
        <Card className="flex items-center gap-3">
          <History size={18} className="text-accent" />
          <div><p className="text-xs text-ink-3">Recorded runs</p><p className="text-lg font-semibold text-ink">{runs.length}</p></div>
        </Card>
        <Card className="flex items-center gap-3">
          <Clock size={18} className={scheduler.configured ? "text-success" : "text-warning"} />
          <div>
            <p className="text-xs text-ink-3">Scheduler</p>
            <p className="text-sm font-medium text-ink">{scheduler.last_success_at ? `checked in ${new Date(scheduler.last_success_at).toLocaleString()}` : scheduler.configured ? "configured · no check-in yet" : "not deployed"}</p>
          </div>
        </Card>
      </div>

      {!scheduler.configured ? (
        <Alert tone="warning">
          Scheduled runs need the automation worker and its server secret deployed. Manual runs work right now; a browser timer is never used as a scheduler.
        </Alert>
      ) : !scheduler.last_success_at ? (
        <Alert>No worker check-in recorded yet. Verify the worker deployment before relying on scheduled runs.</Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {/* --- presets ------------------------------------------------------- */}
      {!loading && (items.length === 0 || templatesOpen) ? (
        <Card className="space-y-3">
          <h2 className="flex items-center gap-2 font-semibold text-ink"><Sparkles size={16} className="text-accent" /> Start with a template</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => openPreset(preset)}
                className="rounded-xl border border-border p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
              >
                <span className="block text-sm font-semibold text-ink">{preset.name}</span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-3">{preset.description}</span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {/* --- workflow list ------------------------------------------------- */}
      {loading ? (
        <Card className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={15} className="animate-spin" /> Loading workflows…</Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Zap />} title="No workflows yet" body="Pick a template above, or build one from scratch with the workflow editor." action={<Button onClick={openNew}><Plus size={15} /> New workflow</Button>} />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id} className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 font-semibold text-ink">{item.name}</h3>
                  <p className="mt-1 text-xs text-ink-2">
                    {item.trigger === "schedule"
                      ? `${item.schedule} · ${item.time} · ${item.timezone}`
                      : item.trigger === "manual" ? "Manual run" : "Event trigger"}
                    {" · "}{item.actions.length} action{item.actions.length === 1 ? "" : "s"} · {item.run_count} run{item.run_count === 1 ? "" : "s"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {item.last_run_at ? `Last run ${new Date(item.last_run_at).toLocaleString()} — ${item.last_run_ok ? "succeeded" : "failed"}` : "Not run yet"}
                    {item.status === "active" && item.next_run_at ? ` · next ${new Date(item.next_run_at).toLocaleString()}` : ""}
                  </p>
                </div>
                <Badge className={item.status === "active" ? "!border-success/40 !text-success" : ""}>{item.status}</Badge>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-md border border-accent/30 bg-accent-soft px-2 py-1 font-medium text-accent">
                  {item.trigger === "schedule" ? `⏰ ${item.time}` : "▶ manual"}
                </span>
                {item.actions.map((action, index) => (
                  <span key={`${action.tool}-${index}`} className="flex items-center gap-1.5">
                    <span className="text-ink-3">→</span>
                    <span className="rounded-md border border-border px-2 py-1 font-mono">{TOOL_LABEL[action.tool] ?? action.tool}</span>
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void runNow(item)} disabled={Boolean(busy)}>
                  {busy === `run-${item.id}` ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run now
                </Button>
                <Button variant="outline" onClick={() => edit(item)} disabled={Boolean(busy)}>Edit</Button>
                <Button variant="outline" onClick={() => void toggleStatus(item)} disabled={Boolean(busy)}>
                  {item.status === "active" ? <Pause size={14} /> : <Play size={14} />} {item.status === "active" ? "Pause" : "Activate"}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(item)} disabled={Boolean(busy)}><Trash2 size={14} /> Remove</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-ink">Execution history</h2>
          <Button variant="outline" onClick={() => setHistoryOpen((value) => !value)}><History size={15} /> {historyOpen ? "Hide" : "Show"}</Button>
        </div>
        {historyOpen ? (
          !runs.length ? <p className="text-sm text-ink-3">No executions recorded yet.</p> : (
            <ul className="space-y-2">
              {runs.map((run) => (
                <li key={run.id} className="rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm">
                      {run.ok ? <CheckCircle2 size={15} className="text-success" /> : <XCircle size={15} className="text-danger" />}
                      <span className="font-medium text-ink">{run.status}</span>
                      <span className="text-xs text-ink-3">· {run.triggered_by} · {new Date(run.created_at).toLocaleString()}</span>
                    </span>
                    <Badge>{run.results.length} step{run.results.length === 1 ? "" : "s"}</Badge>
                  </div>
                  <div className="mt-2 space-y-1">
                    {run.results.map((result, index) => (
                      <div key={index} className="rounded-lg bg-surface-2 p-2 text-[11px]">
                        <span className="font-mono text-ink">{TOOL_LABEL[result.tool] ?? result.tool}</span>
                        <span className={cn("ml-2", result.ok ? "text-success" : "text-danger")}>{result.ok ? "succeeded" : "failed"}</span>
                        {result.error ? <p className="mt-1 text-danger">{result.error}</p> : null}
                        {result.message ? <p className="mt-1 text-ink-2">{result.message}</p> : null}
                      </div>
                    ))}
                    {run.error ? <p className="text-[11px] text-danger">{run.error}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : <p className="text-xs text-ink-3">Show the trail of every run, including which action failed and why.</p>}
      </Card>

      {/* --- editor -------------------------------------------------------- */}
      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing ? "Edit workflow" : "New workflow"}
        description="A trigger, then one to five actions. Only low-risk registered tools are listed."
        size="lg"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={busy === "save"}>Cancel</Button>
            <Button onClick={() => void save()} disabled={busy === "save" || name.trim().length < 2 || steps.some((step) => !step.tool)}>
              {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Save size={15} />} {editing ? "Save changes" : "Create workflow"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Workflow name" htmlFor="auto-name">
              <Input id="auto-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning check-in" maxLength={80} />
            </Field>
            <Field label="Short description (optional)" htmlFor="auto-desc">
              <Input id="auto-desc" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this workflow does" maxLength={160} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Trigger" htmlFor="auto-trigger">
              <Select id="auto-trigger" value={trigger} onChange={(event) => setTrigger(event.target.value)}>
                <option value="manual">Run manually</option>
                <option value="schedule">On a schedule</option>
              </Select>
            </Field>
            {trigger === "schedule" ? (
              <>
                <Field label="Repeat" htmlFor="auto-schedule">
                  <Select id="auto-schedule" value={schedule} onChange={(event) => setSchedule(event.target.value)}>
                    <option value="hourly">Hourly</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </Select>
                </Field>
                <Field label={schedule === "hourly" ? "Minute" : "Local time"} htmlFor="auto-time">
                  <Input id="auto-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
                </Field>
              </>
            ) : null}
          </div>
          {trigger === "schedule" ? (
            <Field label="Timezone" htmlFor="auto-zone" hint="Weekly workflows repeat on the day they were created; missing daylight-saving times are skipped.">
              <Select id="auto-zone" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                {timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </Select>
            </Field>
          ) : null}

          <div className="space-y-0">
            <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft p-3">
              <Clock size={18} className="text-accent" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">Trigger</p>
                <p className="mt-0.5 text-sm text-ink">{trigger === "schedule" ? `${schedule} · ${time} · ${timezone}` : "Run button"}</p>
              </div>
            </div>
            {steps.map((step, index) => {
              const fields = TOOL_FORM[step.tool] ?? [];
              const args = stepArgs(index);
              return (
                <div key={index}>
                  <div className="mx-auto h-5 w-px bg-border-strong" aria-hidden="true" />
                  <section className="rounded-xl border border-border bg-bg p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="eyebrow">Action {index + 1}</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Move action ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
                        <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Move action ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
                        <Button variant="ghost" className="!min-h-8 !px-2" aria-label={`Remove action ${index + 1}`} disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}><Trash2 size={14} /></Button>
                      </div>
                    </div>

                    <Field label="What should happen" htmlFor={`step-tool-${index}`}>
                      <Select
                        id={`step-tool-${index}`}
                        value={step.tool}
                        onChange={(event) => {
                          const tool = event.target.value;
                          const defaults: Record<string, unknown> = tool === "notifications.create"
                            ? { title: "Automation check-in", body: "Your workflow ran successfully.", link: "/automations" }
                            : {};
                          patchStep(index, { tool, argsText: JSON.stringify(defaults, null, 2) });
                        }}
                      >
                        <option value="">Choose an action…</option>
                        {tools.map((tool) => <option key={tool.id} value={tool.id}>{TOOL_LABEL[tool.id] ?? tool.id}</option>)}
                      </Select>
                    </Field>
                    <p className="mt-1.5 text-[11px] text-ink-3">{tools.find((tool) => tool.id === step.tool)?.description ?? "Only registered low-risk tools can run automatically."}</p>

                    {fields.length ? (
                      <div className="mt-3 space-y-2">
                        {fields.map((field) => (
                          <Field key={field.key} label={field.label} htmlFor={`step-${index}-${field.key}`} hint={field.hint}>
                            {field.multiline ? (
                              <Textarea
                                id={`step-${index}-${field.key}`}
                                rows={2}
                                value={String(args[field.key] ?? "")}
                                onChange={(event) => patchArg(index, field.key, event.target.value)}
                                placeholder={field.placeholder}
                              />
                            ) : field.key === "project_id" && projectsList.length > 0 ? (
                              <Select
                                id={`step-${index}-${field.key}`}
                                value={String(args[field.key] ?? "")}
                                onChange={(event) => patchArg(index, field.key, event.target.value)}
                              >
                                <option value="">Choose one of your projects…</option>
                                {projectsList.map((proj) => (
                                  <option key={proj.id} value={proj.id}>{proj.name || proj.id}</option>
                                ))}
                              </Select>
                            ) : (
                              <Input
                                id={`step-${index}-${field.key}`}
                                value={String(args[field.key] ?? "")}
                                onChange={(event) => patchArg(index, field.key, event.target.value)}
                                placeholder={field.placeholder}
                              />
                            )}
                          </Field>
                        ))}
                      </div>
                    ) : step.tool ? (
                      <p className="mt-2 text-[11px] text-warning">This action takes no inputs. Use the JSON editor below only if the tool requires them.</p>
                    ) : null}

                    <button
                      type="button"
                      className="mt-2 text-[11px] font-medium text-ink-3 underline-offset-2 hover:underline"
                      onClick={() => setAdvanced(advanced === index ? null : index)}
                    >
                      {advanced === index ? "Hide" : "Show"} advanced arguments (JSON)
                    </button>
                    {advanced === index ? (
                      <Textarea
                        aria-label={`Action ${index + 1} arguments`}
                        className="mt-1 font-mono text-xs"
                        rows={4}
                        value={step.argsText}
                        onChange={(event) => patchStep(index, { argsText: event.target.value })}
                        spellCheck={false}
                      />
                    ) : null}
                  </section>
                </div>
              );
            })}
          </div>

          <Button variant="outline" disabled={steps.length >= 5} onClick={() => setSteps((current) => [...current, blankStep()])}>
            <Plus size={15} /> Add action
          </Button>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
      </Modal>

      <ConfirmModal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => { const item = confirmDelete; setConfirmDelete(null); if (item) void remove(item); }}
        title="Remove this workflow?"
        body={`“${confirmDelete?.name ?? "This workflow"}” stops running. Execution history is kept.`}
        confirmLabel="Remove workflow"
      />
    </div>
  );
}
