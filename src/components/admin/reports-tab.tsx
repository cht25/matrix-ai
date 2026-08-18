"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Badge, Button, Card, Select, Spinner, Textarea } from "@/components/ui";
import { formatDate } from "@/lib/utils";

type Report = {
  id: string; platform: string; description: string; money_lost: number;
  account_compromised: boolean; personal_information_shared: boolean;
  country: string; status: string; created_at: string; admin_notes: string;
};

export function ReportsTab({ codes }: { codes: Set<string> }) {
  const [items, setItems] = useState<Report[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    const { data } = await supabase
      .from("scam_reports")
      .select("id, platform, description, money_lost, account_compromised, personal_information_shared, country, status, created_at, admin_notes")
      .order("created_at", { ascending: false })
      .limit(50);
    setItems((data ?? []) as Report[]);
    const s: Record<string, string> = {};
    const n: Record<string, string> = {};
    for (const r of (data ?? []) as Report[]) { s[r.id] = r.status; n[r.id] = r.admin_notes; }
    setStatuses(s); setNotes(n);
  }

  useEffect(() => { if (codes.has("reports.view")) void load(); }, [codes]);

  async function update(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from("scam_reports").update({ status: statuses[id], admin_notes: notes[id] }).eq("id", id);
    if (error) { setMsg(error.message); return; }
    await supabase.rpc("log_audit", {
      p_action: "report_status_updated", p_target_type: "scam_reports", p_target_id: id,
      p_reason: `status → ${statuses[id]}`,
    });
    setMsg("Report updated and audited.");
  }

  if (!codes.has("reports.view")) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>reports.view</strong> permission.</p></Card>;
  }
  if (!items) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading…</Card>;
  if (items.length === 0) return <Card><p className="text-sm text-ink-3">No reports yet.</p></Card>;

  return (
    <div className="space-y-3">
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      {items.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-border bg-surface capitalize text-ink-2">{r.status}</Badge>
            <span className="text-sm text-ink-3">{r.platform || "unknown platform"} · {r.country || "—"} · {formatDate(r.created_at)}</span>
          </div>
          <p className="mt-2 text-sm text-ink-2">{r.description}</p>
          <p className="mt-1 text-xs text-ink-3">
            Money lost: ${r.money_lost} · Account compromised: {r.account_compromised ? "yes" : "no"} · Info shared: {r.personal_information_shared ? "yes" : "no"}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select value={statuses[r.id]} onChange={(e) => setStatuses((s) => ({ ...s, [r.id]: e.target.value }))} className="w-40">
              <option value="submitted">submitted</option>
              <option value="in_review">in_review</option>
              <option value="resolved">resolved</option>
              <option value="closed">closed</option>
            </Select>
            <Textarea
              value={notes[r.id]}
              onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
              placeholder="Admin notes (visible to admins only)"
              rows={1}
              className="max-w-sm"
            />
            <Button onClick={() => void update(r.id)}>Save</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

export function AiSafetyTab({ codes }: { codes: Set<string> }) {
  const [items, setItems] = useState<{ id: number; event_type: string; detail: string; created_at: string }[] | null>(null);

  useEffect(() => {
    if (!codes.has("ai.view")) return;
    const supabase = createClient();
    supabase
      .from("ai_safety_events")
      .select("id, event_type, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => setItems((data ?? []) as typeof items));
  }, [codes]);

  if (!codes.has("ai.view")) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>ai.view</strong> permission.</p></Card>;
  }
  if (!items) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading…</Card>;

  return (
    <Card>
      <h2 className="font-bold text-ink">AI safety events</h2>
      <p className="mt-1 text-xs text-ink-3">Off-topic, harmful, injection, PII and refusal events. Only minimal safe metadata is stored — never raw secrets.</p>
      <div className="no-scrollbar mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase text-ink-3">
              <th className="py-2 pr-3">Event</th><th className="py-2 pr-3">Detail</th><th className="py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-b border-border">
                <td className="py-2.5 pr-3"><Badge className="border-border bg-surface text-ink-2">{e.event_type}</Badge></td>
                <td className="max-w-xs truncate py-2.5 pr-3 text-ink-3">{e.detail || "—"}</td>
                <td className="py-2.5 text-ink-3">{formatDate(e.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function AuditTab({ codes }: { codes: Set<string> }) {
  const [items, setItems] = useState<{ id: number; actor_id: string; action: string; target_type: string; target_id: string; reason: string; created_at: string }[] | null>(null);

  useEffect(() => {
    if (!codes.has("audit.view")) return;
    const supabase = createClient();
    supabase
      .from("audit_logs")
      .select("id, actor_id, action, target_type, target_id, reason, created_at")
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => setItems((data ?? []) as typeof items));
  }, [codes]);

  if (!codes.has("audit.view")) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>audit.view</strong> permission (auditor/super_admin).</p></Card>;
  }
  if (!items) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading…</Card>;

  return (
    <Card>
      <h2 className="font-bold text-ink">Audit logs</h2>
      <div className="no-scrollbar mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase text-ink-3">
              <th className="py-2 pr-3">Action</th><th className="py-2 pr-3">Target</th><th className="py-2 pr-3">Reason</th><th className="py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-b border-border">
                <td className="py-2.5 pr-3 font-medium text-ink-2">{e.action}</td>
                <td className="py-2.5 pr-3 text-ink-3">{e.target_type}{e.target_id ? `:${e.target_id.slice(0, 8)}` : ""}</td>
                <td className="max-w-xs truncate py-2.5 pr-3 text-ink-3">{e.reason || "—"}</td>
                <td className="py-2.5 text-ink-3">{formatDate(e.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
