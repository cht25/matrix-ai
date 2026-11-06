"use client";

// Automations UI — create scheduled/manual workflows whose actions are
// REGISTERED tools. Only LOW-risk tools are selectable; execution always goes
// through the guarded server gateway (authorize → validate → audit).

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, Select } from "@/components/ui";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Zap } from "lucide-react";

type ToolInfo = { id: string; description: string; risk: string; approvalRequired: boolean };
type Automation = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  schedule: string | null;
  actions: { tool: string }[];
  status: string;
  run_count: number;
  last_run_ok: boolean | null;
  last_run_at: string | null;
};

function errMsg(err: unknown, fallback: string): string {
  if (err instanceof RpcCallError) return err.code.replace(/_/g, " ").toLowerCase();
  return fallback;
}

export function AutomationsClient() {
  const toast = useToast();
  const [items, setItems] = useState<Automation[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("manual");
  const [schedule, setSchedule] = useState("daily");
  const [tool, setTool] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, toolList] = await Promise.all([
        rpc<Automation[]>("automation_list"),
        fetch("/api/agent/tools", { credentials: "same-origin" }).then((r) => r.json()),
      ]);
      setItems(list);
      setTools(((toolList as { tools: ToolInfo[] }).tools ?? []).filter((t) => t.risk === "low" && !t.approvalRequired));
    } catch {
      toast("Could not load automations.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!name.trim() || !tool) return;
    setBusy(true);
    try {
      await rpc("automation_create", {
        name: name.trim(),
        trigger,
        schedule: trigger === "schedule" ? schedule : null,
        actions: [{ tool }],
      });
      setName("");
      toast("Automation created.");
      await load();
    } catch (err) {
      toast(errMsg(err, "Could not create automation."));
    } finally {
      setBusy(false);
    }
  }

  async function runNow(id: string) {
    setBusy(true);
    try {
      const res = await rpc<{ ok: boolean }>("automation_run", { id, source: "manual" });
      toast(res.ok ? "Run succeeded." : "Run finished with failures — see server logs.");
      await load();
    } catch (err) {
      toast(errMsg(err, "Run failed."));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(a: Automation) {
    setBusy(true);
    try {
      await rpc("automation_status", { id: a.id, status: a.status === "active" ? "paused" : "active" });
      await load();
    } catch (err) {
      toast(errMsg(err, "Could not update."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await rpc("automation_delete", { id });
      toast("Automation deleted.");
      await load();
    } catch (err) {
      toast(errMsg(err, "Could not delete."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Automations</h1>
        <p className="mt-1 text-ink-2">
          Schedule or trigger workflows whose steps are registered MATRIX tools. Every run is authorized, risk-checked and
          audited server-side — only low-risk tools can be automated.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-ink">New automation</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="auto-name">
            <Input id="auto-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning brief" maxLength={80} />
          </Field>
          <Field label="Trigger" htmlFor="auto-trigger">
            <Select id="auto-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="manual">Manual</option>
              <option value="schedule">Scheduled</option>
              <option value="event">Event</option>
            </Select>
          </Field>
          {trigger === "schedule" ? (
            <Field label="Schedule" htmlFor="auto-schedule">
              <Select id="auto-schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)}>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
            </Field>
          ) : null}
          <Field label="Tool action" htmlFor="auto-tool">
            <Select id="auto-tool" value={tool} onChange={(e) => setTool(e.target.value)}>
              <option value="">Choose a low-risk tool…</option>
              {tools.map((t) => (
                <option key={t.id} value={t.id}>{t.id}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Button onClick={create} disabled={busy || !name.trim() || !tool}>Create automation</Button>
      </Card>

      {loading ? (
        <Card className="p-4 text-sm text-ink-3">Loading…</Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Zap size={22} />} title="No automations yet" body="Create one above — its actions must be registered low-risk tools." />
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <li key={a.id}>
              <Card className="flex flex-wrap items-center justify-between gap-2 p-4">
                <div>
                  <p className="font-semibold text-ink">{a.name}</p>
                  <p className="text-xs text-ink-3">
                    <Badge>{a.trigger}{a.schedule ? ` · ${a.schedule}` : ""}</Badge> <Badge>{a.status}</Badge> actions:{" "}
                    {a.actions.map((x) => x.tool).join(", ")} · runs: {a.run_count}
                    {a.last_run_at ? ` · last ${new Date(a.last_run_at).toLocaleString()} (${a.last_run_ok ? "ok" : "failed"})` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => void runNow(a.id)} disabled={busy}>Run</Button>
                  <Button variant="outline" onClick={() => void toggleStatus(a)} disabled={busy}>
                    {a.status === "active" ? "Pause" : "Activate"}
                  </Button>
                  <Button variant="danger" onClick={() => void remove(a.id)} disabled={busy}>Delete</Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
