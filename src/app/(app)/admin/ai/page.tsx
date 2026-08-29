"use client";

import { useEffect, useState } from "react";
import { rpc } from "@/lib/client/api";
import { Card, Spinner } from "@/components/ui";
import { AiProviderSettings } from "@/components/admin/ai-provider-settings";

type Row = {
  id: string;
  user_id: string;
  model: string;
  request_type: string;
  status: string;
  latency_ms: number;
  created_at: string;
};

export default function AdminAiPage() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    void rpc<Row[]>("admin_ai_usage").then(setRows).catch(() => setRows([]));
  }, []);

  return (
    <div className="space-y-6">
      <AiProviderSettings />
      <Card>
      <h1 className="font-display text-xl font-semibold text-ink">AI usage</h1>
      <p className="mt-1 text-sm text-ink-2">Recent gateway calls. Super admins can also seed RBAC from Setup.</p>
      {!rows ? <div className="mt-4 flex items-center gap-2 text-ink-3"><Spinner /> Loading…</div> : (
        <ul className="mt-4 space-y-1.5 text-xs">
          {rows.length === 0 ? <li className="text-ink-3">No usage logs yet.</li> : rows.map((r) => (
            <li key={r.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
              <span className="font-mono text-ink-2">{r.request_type} · {r.model || "—"} · {r.status}</span>
              <span className="text-ink-3">{r.latency_ms}ms · {r.created_at.slice(0, 16).replace("T", " ")}</span>
            </li>
          ))}
        </ul>
      )}
      </Card>
    </div>
  );
}
