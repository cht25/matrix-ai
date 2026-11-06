"use client";

// Agent Studio — unified tool registry panel. Lists the tools the Agent may
// request and lets the user run read-only (LOW risk) tools directly through
// the guarded gateway. MEDIUM+ tools show that explicit approval is required —
// the UI never pretends they auto-ran.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { Wrench } from "lucide-react";

type ToolInfo = {
  id: string;
  description: string;
  category: string;
  risk: "low" | "medium" | "high" | "critical";
  requiredPermissions: string[];
  environment: string;
  approvalRequired: boolean;
  auditRequired: boolean;
};

type ToolOutcome = { ok: boolean; data?: Record<string, unknown>; error?: string; request_id?: string };

export function AgentToolsPanel() {
  const toast = useToast();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ToolOutcome>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/tools", { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP_" + res.status);
      setTools(((await res.json()) as { tools: ToolInfo[] }).tools);
    } catch {
      toast("Could not load the tool registry.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(tool: ToolInfo) {
    setRunning(tool.id);
    try {
      const res = await fetch("/api/agent/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ tool: tool.id, args: {} }),
      });
      const body = (await res.json()) as ToolOutcome;
      setOutcomes((o) => ({ ...o, [tool.id]: body }));
      if (!body.ok) toast(body.error ?? "Tool call failed.");
    } catch {
      toast("Tool call failed.");
    } finally {
      setRunning(null);
    }
  }

  return (
    <Card className="mt-6 p-4">
      <div className="flex items-center gap-2">
        <Wrench size={16} className="text-ink-3" />
        <h2 className="font-semibold text-ink">Agent tools</h2>
        <span className="text-xs text-ink-3">server-registered · authorized per call · audited</span>
      </div>
      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-3"><Spinner className="h-4 w-4" /> Loading registry…</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {tools.map((t) => {
            const outcome = outcomes[t.id];
            return (
              <li key={t.id} className="rounded-[10px] bg-surface-2 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-ink">{t.id}</p>
                    <p className="text-xs text-ink-3">{t.description}</p>
                    <p className="mt-1 flex flex-wrap gap-1 text-[10px] text-ink-3">
                      <Badge>{t.risk}</Badge>
                      <Badge>{t.environment}</Badge>
                      {t.approvalRequired ? <Badge>approval required</Badge> : null}
                      {t.auditRequired ? <Badge>audit</Badge> : null}
                    </p>
                  </div>
                  {t.risk === "low" && !t.approvalRequired ? (
                    <Button variant="secondary" onClick={() => void run(t)} disabled={running === t.id}>
                      {running === t.id ? "Running…" : "Run"}
                    </Button>
                  ) : (
                    <span className="text-[11px] text-ink-3">approval-gated</span>
                  )}
                </div>
                {outcome ? (
                  <pre className="mt-2 max-h-40 overflow-auto rounded-[8px] bg-bg p-2 font-mono text-[11px] text-ink-2">
                    {JSON.stringify(outcome.ok ? outcome.data : { error: outcome.error }, null, 2)}
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
