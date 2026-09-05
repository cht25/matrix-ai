"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, RefreshCw, Search } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Select, TableSkeleton } from "@/components/ui";
import { errorCodeOf, mapAdminError, type AdminErrorView } from "@/lib/admin-errors";
import { roleLabel } from "@/lib/roles";
import { formatDate } from "@/lib/utils";

type Entry = {
  id: string; actor_id: string; action: string; target_type: string; target_id: string;
  reason: string; created_at: string;
  metadata?: { previous_role?: string; new_role?: string; result?: string } & Record<string, unknown>;
};

const ACTION_LABEL: Record<string, string> = {
  admin_role_assigned: "Role assigned",
  admin_role_removed: "Admin access removed",
  admin_bootstrap: "First administrator created",
  user_disabled: "Account suspended",
  user_enabled: "Account reactivated",
  report_status_updated: "Scam report updated",
  ai_provider_settings_updated: "AI configuration changed",
  ai_provider_settings_viewed: "AI configuration viewed",
  ai_provider_settings_tested: "AI configuration tested",
  site_unpublished: "Published site removed",
};

function label(action: string) {
  return ACTION_LABEL[action] ?? action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function AuditLog({ codes }: { codes: string[] }) {
  const canView = codes.includes("audit.view");
  const [items, setItems] = useState<Entry[] | null>(null);
  const [error, setError] = useState<AdminErrorView | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");

  const load = useCallback(async () => {
    if (!canView) return;
    setItems(null);
    setError(null);
    try {
      setItems((await rpc<Entry[]>("admin_audit_logs")) ?? []);
    } catch (err) {
      const view = mapAdminError(errorCodeOf(err, "LOAD_FAILED"));
      console.error("[MATRIX admin] audit log load failed", view.code, err);
      setError(view);
    }
  }, [canView]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((e) => {
      if (kind === "roles" && !e.action.startsWith("admin_role")) return false;
      if (kind === "accounts" && !["user_disabled", "user_enabled"].includes(e.action)) return false;
      if (kind === "system" && !e.action.startsWith("ai_") && e.action !== "site_unpublished") return false;
      if (!needle) return true;
      return `${e.action} ${e.actor_id} ${e.target_id} ${e.reason}`.toLowerCase().includes(needle);
    });
  }, [items, q, kind]);

  if (!canView) {
    return (
      <Card>
        <EmptyState title="Audit logs are restricted" body="This section requires the audit permission (auditor or super administrator)." />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="!p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audit entries" placeholder="Search actions, actors or targets…" className="!pl-9" />
          </div>
          <Select aria-label="Filter by category" value={kind} onChange={(e) => setKind(e.target.value)} className="!min-h-10 text-sm sm:w-52">
            <option value="all">All activity</option>
            <option value="roles">Role changes</option>
            <option value="accounts">Account status</option>
            <option value="system">System &amp; AI</option>
          </Select>
          <Button variant="outline" className="!min-h-10" onClick={() => void load()}>
            <RefreshCw aria-hidden className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </Card>

      {error ? (
        <ErrorState title={error.title} detail={error.detail} code={error.code} onRetry={() => void load()} />
      ) : !items ? (
        <Card><TableSkeleton rows={6} cols={4} label="Loading audit log…" /></Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title="No audit entries found"
            body={q || kind !== "all" ? "Try changing your search or filters." : "Administrative actions will appear here as they happen."}
            action={q || kind !== "all" ? <Button variant="outline" className="!min-h-9 text-xs" onClick={() => { setQ(""); setKind("all"); }}>Clear filters</Button> : undefined}
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {visible.map((e) => {
            const prev = e.metadata?.previous_role;
            const next = e.metadata?.new_role;
            const isRole = e.action.startsWith("admin_role");
            return (
              <li key={e.id} className="row-in rounded-2xl border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={isRole ? "border-accent/30 bg-accent-soft text-accent" : "border-border bg-surface-2 text-ink-2"}>
                    {label(e.action)}
                  </Badge>
                  {e.metadata?.result === "success" ? <Badge className="border-success/30 bg-success-soft text-success">Success</Badge> : null}
                  <span className="text-xs text-ink-3">{formatDate(e.created_at)}</span>
                </div>
                {isRole && (prev || next) ? (
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink">
                    <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2">
                      {prev && prev !== "none" ? roleLabel(prev) : "Standard user"}
                    </span>
                    <ArrowRight aria-hidden className="h-3.5 w-3.5 text-ink-3" />
                    <span className="rounded-md border border-accent/30 bg-accent-soft px-2 py-0.5 font-mono text-[11px] text-accent">
                      {next && next !== "none" ? roleLabel(next) : "Standard user"}
                    </span>
                  </p>
                ) : null}
                {e.reason ? <p className="mt-2 text-sm text-ink-2">{e.reason}</p> : null}
                <p className="mt-2 font-mono text-[11px] text-ink-3">
                  actor {e.actor_id.slice(0, 10)} · target {e.target_type || "—"}
                  {e.target_id ? `:${e.target_id.slice(0, 10)}` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
