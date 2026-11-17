"use client";

// =============================================================================
// Admin → Email Provider Diagnostics (Resend Dual-Sender Status).
// Never displays or requests RESEND_API_KEY values; shows boolean configured
// status, live Resend domain verification, health, and masked delivery logs.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Mail, RefreshCw, Send, ShieldAlert, XCircle } from "lucide-react";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { rpc, RpcCallError } from "@/lib/client/api";

type SenderRow = {
  email: string;
  domain: string;
  role: "primary" | "fallback";
  status: "verified" | "unverified" | "degraded" | "unknown";
  resend_domain_status: string;
  last_checked_at: string;
  last_success_at: string;
  last_error_code: string | null;
  last_error_detail: string | null;
  consecutive_failures: number;
};

type LogRow = {
  id: string;
  template_type: string;
  recipient_masked: string;
  requested_sender: string;
  sender_used: string | null;
  fallback_used: boolean;
  status: string;
  error_category: string | null;
  error_code: string | null;
  error_detail: string | null;
  attempts: number;
  created_at: string;
};

type StatusPayload = {
  api_key_configured: boolean;
  parent_notification_email_configured: boolean;
  senders: SenderRow[];
  recent_logs: LogRow[];
};

function toneBadge(status: SenderRow["status"]) {
  switch (status) {
    case "verified":
      return <Badge className="!border-success/40 !text-success"><CheckCircle2 size={12} /> Verified & ready</Badge>;
    case "unverified":
      return <Badge className="!border-warning/40 !text-warning"><ShieldAlert size={12} /> Unverified (inactive)</Badge>;
    case "degraded":
      return <Badge className="!border-danger/40 !text-danger"><XCircle size={12} /> Degraded</Badge>;
    default:
      return <Badge>Unchecked</Badge>;
  }
}

export function EmailProviderStatus() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await rpc<StatusPayload>("admin_email_status");
      setData(res);
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not load email provider status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshDomains() {
    setBusy("refresh");
    setError("");
    setNotice("");
    try {
      const res = await rpc<{ probe: { probed: boolean; error?: string; domains_listed: number }; status: StatusPayload }>(
        "admin_email_refresh_domains",
      );
      setData(res.status);
      if (res.probe.probed) {
        setNotice(`Checked ${res.probe.domains_listed} domain(s) in Resend and updated sender verification status.`);
      } else {
        setError(`Resend domain probe failed: ${res.probe.error ?? "unknown error"}`);
      }
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Domain status refresh failed.");
    } finally {
      setBusy("");
    }
  }

  async function sendTest() {
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const res = await rpc<{
        result: { ok: boolean; status: string; sender_used?: string; fallback_used: boolean; error_code?: string; reason?: string };
        status: StatusPayload;
      }>("admin_email_test_send");
      setData(res.status);
      if (res.result.ok) {
        setNotice(
          `Test email accepted by Resend using ${res.result.sender_used ?? "configured sender"}${
            res.result.fallback_used ? " (fallback triggered because primary sender domain was unverified)" : " (primary sender)"
          }.`,
        );
      } else {
        setError(res.result.reason ?? res.result.error_code ?? "Test email send failed.");
      }
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not send diagnostic test email.");
    } finally {
      setBusy("");
    }
  }

  if (loading && !data) {
    return <p className="text-sm text-ink-3">Loading Resend email diagnostics…</p>;
  }

  return (
    <div className="space-y-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Mail size={18} className="text-accent" />
              <h2 className="font-semibold text-ink">Resend Provider Configuration</h2>
            </div>
            <p className="text-xs text-ink-3">
              Dual-sender chain: Primary → Fallback 1 → Fallback 2. Automatic fallback triggers only on unverified/disallowed sender domain errors. API keys stay strictly server-side and are never returned.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy !== ""} onClick={() => void refreshDomains()}>
              <RefreshCw size={14} className={busy === "refresh" ? "animate-spin" : ""} />
              Verify domains
            </Button>
            <Button disabled={busy !== "" || !data?.api_key_configured} onClick={() => void sendTest()}>
              <Send size={14} />
              Send test email
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface-2/60 p-3">
            <p className="text-xs text-ink-3">RESEND_API_KEY</p>
            <p className="mt-1 text-sm font-medium text-ink">
              {data?.api_key_configured ? "Configured on server (hidden)" : "Not configured"}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface-2/60 p-3">
            <p className="text-xs text-ink-3">PARENT_NOTIFICATION_EMAIL (env default)</p>
            <p className="mt-1 text-sm font-medium text-ink">
              {data?.parent_notification_email_configured ? "Configured on server" : "Not set (uses verified user parent links)"}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-ink">Configured Sender Chain</h3>
        <div className="mt-3 space-y-2.5">
          {(data?.senders ?? []).map((sender, idx) => (
            <div key={sender.email} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/50 p-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-ink-3">#{idx + 1}</span>
                  <span className="font-medium text-ink">{sender.email}</span>
                  <Badge>{sender.role === "primary" ? "Primary" : "Fallback"}</Badge>
                  {toneBadge(sender.status)}
                </div>
                <p className="mt-1 text-xs text-ink-3">
                  Domain: <span className="font-mono">{sender.domain}</span> · Resend status: <span className="font-mono">{sender.resend_domain_status}</span>
                  {sender.last_error_code ? ` · Last error: ${sender.last_error_code}` : ""}
                </p>
                {sender.last_error_detail ? (
                  <p className="mt-0.5 text-[11px] text-warning">{sender.last_error_detail}</p>
                ) : null}
              </div>
              <div className="text-right text-[11px] text-ink-3">
                {sender.last_checked_at ? <div>Checked: {new Date(sender.last_checked_at).toLocaleString()}</div> : <div>Never probed</div>}
                {sender.last_success_at ? <div>Last sent: {new Date(sender.last_success_at).toLocaleString()}</div> : null}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-ink">Recent Email Delivery Logs</h3>
        {(data?.recent_logs ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">No delivery attempts recorded yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-ink-3">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Template</th>
                  <th className="py-2 pr-3 font-medium">Recipient</th>
                  <th className="py-2 pr-3 font-medium">Sender used</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {(data?.recent_logs ?? []).map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap py-2 pr-3 text-ink-3">
                      {log.created_at ? new Date(log.created_at).toLocaleString() : "—"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-ink">{log.template_type}</td>
                    <td className="py-2 pr-3 font-mono text-ink-2">{log.recipient_masked}</td>
                    <td className="py-2 pr-3 font-mono text-ink-2">
                      {log.sender_used ?? log.requested_sender}
                      {log.fallback_used ? " (fallback)" : ""}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge className={log.status === "sent" ? "!border-success/40 !text-success" : "!border-danger/40 !text-danger"}>
                        {log.status}
                      </Badge>
                    </td>
                    <td className="py-2 text-ink-3">
                      {log.error_code ? `${log.error_code}${log.error_detail ? ` · ${log.error_detail}` : ""}` : `${log.attempts} attempt(s)`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
