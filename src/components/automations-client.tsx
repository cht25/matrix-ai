"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Clock, History, Play, Plus, Save, Trash2, Zap } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";

type ToolInfo = { id: string; description: string; risk: string; approvalRequired: boolean };
type Action = { tool: string; args?: Record<string, unknown> };
type Automation = { id: string; name: string; description: string; trigger: string; schedule: string | null; actions: Action[]; status: string; run_count: number; last_run_ok: boolean | null; last_run_at: string | null; time?: string; timezone?: string; next_run_at?: string | null };
type Step = { tool: string; argsText: string };
type Run = { id: string; automation_id: string; status: string; ok: boolean; triggered_by: string; created_at: string; error?: string; results: { tool: string; ok: boolean; error?: string; message?: string; data?: string }[] };
type Scheduler = { configured: boolean; last_success_at: string | null };
const blankStep = (): Step => ({ tool: "", argsText: "{}" });

export function AutomationsClient() {
  const toast = useToast();
  const [items, setItems] = useState<Automation[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [scheduler, setScheduler] = useState<Scheduler>({ configured: false, last_success_at: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("manual");
  const [schedule, setSchedule] = useState("daily");
  const [time, setTime] = useState("07:00");
  const [timezone, setTimezone] = useState("UTC");
  const [steps, setSteps] = useState<Step[]>([blankStep()]);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, toolResponse, history, status] = await Promise.all([
        rpc<Automation[]>("automation_list"),
        fetch("/api/agent/tools", { credentials: "same-origin" }).then(async (response) => { if (!response.ok) throw new Error("TOOLS_UNAVAILABLE"); return response.json() as Promise<{ tools: ToolInfo[] }>; }),
        rpc<Run[]>("automation_runs_list"), rpc<Scheduler>("automation_scheduler_status"),
      ]);
      setItems(list); setTools(toolResponse.tools.filter((tool) => tool.risk === "low" && !tool.approvalRequired)); setRuns(history); setScheduler(status); setError("");
    } catch { setError("Could not load automations and execution history. Check your connection and retry."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function patchStep(index: number, patch: Partial<Step>) { setSteps((current) => current.map((step, i) => i === index ? { ...step, ...patch } : step)); }
  function move(index: number, direction: number) {
    setSteps((current) => { const next = [...current]; const target = index + direction; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }
  function reset() { setEditing(""); setName(""); setTrigger("manual"); setSchedule("daily"); setTime("07:00"); setTimezone("UTC"); setSteps([blankStep()]); }
  function edit(item: Automation) {
    setEditing(item.id); setName(item.name); setTrigger(item.trigger); setSchedule(item.schedule ?? "daily"); setTime(item.time ?? "07:00"); setTimezone(item.timezone ?? "UTC");
    setSteps(item.actions.map((action) => ({ tool: action.tool, argsText: JSON.stringify(action.args ?? {}, null, 2) })));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function save() {
    setError("");
    let actions: Action[];
    try { actions = steps.map((step) => { const args = JSON.parse(step.argsText); if (!step.tool || !args || typeof args !== "object" || Array.isArray(args)) throw new Error(); return { tool: step.tool, args }; }); }
    catch { setError("Every step needs a tool and a valid JSON object for its arguments."); return; }
    setBusy(true);
    try {
      const payload = { name: name.trim(), trigger, schedule: trigger === "schedule" ? schedule : null, time, timezone, actions };
      await rpc(editing ? "automation_update" : "automation_create", editing ? { id: editing, ...payload } : payload);
      reset(); await load(); toast(editing ? "Workflow updated." : "Workflow saved. Scheduled runs require the worker shown below.");
    } catch (err) { setError(err instanceof RpcCallError ? err.code.replaceAll("_", " ") : "Could not save this workflow."); }
    finally { setBusy(false); }
  }
  async function act(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setError("");
    try { await operation(); await load(); toast(success); }
    catch (err) { setError(err instanceof RpcCallError ? err.code.replaceAll("_", " ") : "Operation failed. No success was recorded."); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-5xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow text-accent">Automation / control</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Automations</h1><p className="mt-2 text-sm text-ink-2">Connect triggers to real, authorized actions. Every execution leaves a verifiable trail.</p></div><Badge><Clock size={12} />{scheduler.last_success_at ? `Worker checked in ${new Date(scheduler.last_success_at).toLocaleString()}` : scheduler.configured ? "Worker configured · no check-in yet" : "Worker not deployed"}</Badge></header>
    {!scheduler.configured ? <Alert tone="warning">Manual runs work through the backend. Scheduled workflows will not run until the automation worker and its server secret are deployed. A browser timer is not used as a scheduler.</Alert> : !scheduler.last_success_at ? <Alert>No worker check-in has been recorded yet. Verify the worker deployment before relying on scheduled execution.</Alert> : null}
    {error ? <Alert tone="danger">{error}</Alert> : null}
    <Card className="space-y-5">
      <div className="flex items-center justify-between"><h2 className="font-semibold">{editing ? "Edit workflow" : "New workflow"}</h2>{editing ? <Button variant="ghost" onClick={reset}>Cancel edit</Button> : <Badge>Visual step editor</Badge>}</div>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Workflow name" htmlFor="auto-name"><Input id="auto-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning check-in" maxLength={80} /></Field><Field label="Trigger" htmlFor="auto-trigger"><Select id="auto-trigger" value={trigger} onChange={(event) => setTrigger(event.target.value)}><option value="manual">Manual run</option><option value="schedule">Schedule</option>{trigger === "event" ? <option value="event">Legacy event (no dispatcher configured)</option> : null}</Select></Field></div>
      {trigger === "schedule" ? <div className="grid gap-3 sm:grid-cols-3"><Field label="Repeat" htmlFor="auto-schedule"><Select id="auto-schedule" value={schedule} onChange={(event) => setSchedule(event.target.value)}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></Select></Field><Field label={schedule === "hourly" ? "At minute (hour field ignored)" : "Local time"} htmlFor="auto-time"><Input id="auto-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></Field><Field label="IANA timezone" htmlFor="auto-zone"><Input id="auto-zone" list="matrix-timezones" value={timezone} onChange={(event) => setTimezone(event.target.value)} /><datalist id="matrix-timezones"><option value="UTC" /><option value="Asia/Dhaka" /><option value="America/New_York" /><option value="Europe/London" /></datalist></Field><p className="text-xs text-ink-3 sm:col-span-3">Weekly workflows repeat on the creation weekday. Timezone-aware scheduling skips nonexistent daylight-saving times.</p></div> : null}
      <div className="space-y-0">
        <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft p-4"><Clock size={18} className="text-accent" /><div><p className="text-xs font-semibold text-accent">TRIGGER</p><p className="mt-1 text-sm">{trigger === "schedule" ? `${schedule} · ${time} · ${timezone}` : trigger === "manual" ? "Run button" : "Legacy event trigger — not scheduled"}</p></div></div>
        {steps.map((step, index) => <div key={index}><div className="mx-auto h-6 w-px bg-border-strong" /><section className="rounded-xl border border-border bg-bg p-4"><div className="mb-3 flex items-center justify-between gap-2"><span className="eyebrow">Action {index + 1}</span><div className="flex gap-1"><Button variant="ghost" aria-label={`Move action ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></Button><Button variant="ghost" aria-label={`Move action ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></Button><Button variant="ghost" aria-label={`Remove action ${index + 1}`} disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}><Trash2 size={14} /></Button></div></div><Field label="Registered tool" htmlFor={`step-tool-${index}`}><Select id={`step-tool-${index}`} value={step.tool} onChange={(event) => patchStep(index, { tool: event.target.value, argsText: event.target.value === "notifications.create" ? JSON.stringify({ title: "Automation check-in", body: "Your workflow ran successfully.", link: "/automations" }, null, 2) : "{}" })}><option value="">Choose an action…</option>{tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.id}</option>)}</Select></Field><p className="mt-2 text-xs text-ink-2">{tools.find((tool) => tool.id === step.tool)?.description ?? "Only registered low-risk tools can run automatically."}</p><details className="mt-3" open={step.tool === "notifications.create" || step.tool === "projects.get"}><summary className="cursor-pointer text-xs font-medium text-ink-2">Arguments (JSON)</summary><Textarea aria-label={`Action ${index + 1} arguments`} className="mt-2 font-mono text-xs" rows={4} value={step.argsText} onChange={(event) => patchStep(index, { argsText: event.target.value })} spellCheck={false} /></details></section></div>)}
      </div>
      <div className="flex flex-wrap justify-between gap-2"><Button variant="outline" disabled={steps.length >= 5} onClick={() => setSteps((current) => [...current, blankStep()])}><Plus size={15} /> Add action</Button><Button disabled={busy || name.trim().length < 2 || steps.some((step) => !step.tool)} onClick={() => void save()}><Save size={15} />{busy ? "Saving…" : editing ? "Save changes" : "Create workflow"}</Button></div>
    </Card>
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Your workflows</h2><Button variant="outline" onClick={() => setShowHistory(!showHistory)}><History size={15} />{showHistory ? "Hide history" : "Execution history"}</Button></div>
    {showHistory ? <Card className="space-y-3"><h3 className="font-semibold">Recent executions</h3>{!runs.length ? <p className="text-sm text-ink-2">No executions recorded yet.</p> : runs.map((run) => <details key={run.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm"><span className={run.ok ? "text-success" : "text-danger"}>{run.status}</span> · {run.triggered_by} · {new Date(run.created_at).toLocaleString()}</summary><div className="mt-3 space-y-2">{run.results.map((result, index) => <div key={index} className="rounded-lg bg-surface-2 p-3 text-xs"><p className="font-mono">{result.tool} · {result.ok ? "succeeded" : "failed"}</p>{result.error ? <p className="mt-1 text-danger">{result.error}</p> : null}{result.message ? <p className="mt-1 text-ink-2">{result.message}</p> : null}{result.data ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-ink-3">{result.data}</pre> : null}</div>)}{run.error ? <p className="text-xs text-danger">{run.error}</p> : null}</div></details>)}</Card> : null}
    {loading ? <Card>Loading workflows…</Card> : !items.length ? <EmptyState icon={<Zap />} title="No workflows yet" body="Build a workflow above. A manual projects-list → notification workflow is a useful first check of the real execution path." /> : <div className="space-y-3">{items.map((item) => <Card key={item.id} className="space-y-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{item.name}</h3><p className="mt-1 text-xs text-ink-2">{item.trigger}{item.schedule ? ` · ${item.schedule} · ${item.time} ${item.timezone}` : ""} · {item.actions.length} action(s) · {item.run_count} run(s)</p>{item.next_run_at && item.status === "active" ? <p className="mt-1 text-xs text-ink-3">Next due {new Date(item.next_run_at).toLocaleString()}</p> : null}</div><Badge className={item.status === "active" ? "text-success" : ""}>{item.status}</Badge></div><div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">{item.actions.map((action, index) => <span key={index} className="rounded-md border border-border px-2 py-1 font-mono">{action.tool}</span>)}</div><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => void act(() => rpc<{ ok: boolean }>("automation_run", { id: item.id }).then((result) => { if (!result.ok) throw new Error("ACTION_FAILED"); }), "Run completed successfully.")}><Play size={14} /> Run now</Button><Button variant="outline" disabled={busy} onClick={() => edit(item)}>Edit</Button><Button variant="outline" disabled={busy} onClick={() => void act(() => rpc("automation_status", { id: item.id, status: item.status === "active" ? "paused" : "active" }), "Workflow status updated.")}>{item.status === "active" ? "Pause" : "Activate"}</Button><Button variant="ghost" disabled={busy} onClick={() => { if (confirm("Remove this workflow? Execution history is retained.")) void act(() => rpc("automation_delete", { id: item.id }), "Workflow removed."); }}><Trash2 size={14} /> Remove</Button></div></Card>)}</div>}
  </div>;
}
