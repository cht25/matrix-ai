"use client";

// DEV-ONLY. Renders the real UsersTab / AuditLog / AdminNav components against
// a mocked /api/rpc + /api/health transport so the redesign can be reviewed
// without Firebase credentials. Not reachable in production.

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { UsersTab } from "@/components/admin/users-tab";
import { AuditLog } from "@/components/admin/audit-log";
import { SystemStatusPill, SystemPulse } from "@/components/admin/system-status";
import { Button, Card } from "@/components/ui";
import { ADMIN_ROLES, NO_ROLE } from "@/lib/roles";
import { ALL_ADMIN_PERMISSION_CODES } from "@/lib/admin-rbac";

const CODES = [...ALL_ADMIN_PERMISSION_CODES];

type MockUser = {
  id: string; email: string; full_name: string; created_at: string; last_sign_in_at: string | null;
  age_verified: boolean; country: string; consent_status: string; identity_status: string;
  disabled: boolean; admin_role: string | null;
};

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const USERS: MockUser[] = [
  { id: "u-alex-0001", email: "alex@matrix.test", full_name: "Alex Rahman", created_at: day(120), last_sign_in_at: day(0), age_verified: true, country: "BD", consent_status: "approved", identity_status: "approved", disabled: false, admin_role: null },
  { id: "u-nadia-002", email: "nadia@matrix.test", full_name: "Nadia Karim", created_at: day(95), last_sign_in_at: day(1), age_verified: true, country: "BD", consent_status: "approved", identity_status: "approved", disabled: false, admin_role: "super_admin" },
  { id: "u-imran-003", email: "imran@matrix.test", full_name: "Imran Hossain", created_at: day(60), last_sign_in_at: day(4), age_verified: false, country: "BD", consent_status: "pending", identity_status: "pending_review", disabled: false, admin_role: "security_admin" },
  { id: "u-sara-0004", email: "sara@matrix.test", full_name: "Sara Chowdhury", created_at: day(30), last_sign_in_at: null, age_verified: false, country: "GB", consent_status: "none", identity_status: "none", disabled: true, admin_role: null },
  { id: "u-tan-00005", email: "tanvir@matrix.test", full_name: "Tanvir Ahmed", created_at: day(12), last_sign_in_at: day(2), age_verified: true, country: "BD", consent_status: "approved", identity_status: "approved", disabled: false, admin_role: "auditor" },
];

type Audit = { id: string; actor_id: string; action: string; target_type: string; target_id: string; reason: string; created_at: string; metadata: Record<string, unknown> };
const AUDITS: Audit[] = [
  { id: "a3", actor_id: "u-nadia-002", action: "admin_role_assigned", target_type: "user", target_id: "u-imran-003", reason: "security_admin", created_at: day(0), metadata: { previous_role: "none", new_role: "security_admin", result: "success" } },
  { id: "a2", actor_id: "u-nadia-002", action: "user_disabled", target_type: "user", target_id: "u-sara-0004", reason: "", created_at: day(1), metadata: { result: "success" } },
  { id: "a1", actor_id: "u-nadia-002", action: "admin_bootstrap", target_type: "admin_role_assignments", target_id: "u-nadia-002", reason: "first super_admin", created_at: day(120), metadata: { result: "success" } },
];

/** Install a mock fetch for /api/rpc + /api/health only. */
function useMockTransport() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const real = window.fetch.bind(window);
    const users = USERS.map((u) => ({ ...u }));
    const audits = [...AUDITS];

    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      if (url.includes("/api/health")) {
        return json({ ok: true, firebase: "reachable", webConfig: "valid", cloudinary: "reachable", ai: "online", codingAi: "online", codingProvider: "openrouter", codingModel: "preview", checkedAt: new Date().toISOString() });
      }

      if (url.includes("/api/rpc")) {
        await new Promise((r) => setTimeout(r, 320)); // show the skeleton loaders
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        switch (body.action) {
          case "admin_list_users":
            return json({ success: true, data: users });
          case "admin_audit_logs":
            return json({ success: true, data: audits });
          case "admin_role_catalog":
            return json({
              success: true,
              data: {
                roles: ADMIN_ROLES.map((r) => ({ id: r.id, label: r.label, description: r.description, tone: r.tone, permissions: [...r.permissions] })),
                permissions: CODES,
                none: { id: NO_ROLE, label: "Standard user (no admin access)" },
              },
            });
          case "admin_set_role": {
            const role = String(body.role);
            const valid = role === NO_ROLE || ADMIN_ROLES.some((r) => r.id === role);
            if (!valid) return json({ success: false, error: { code: "ROLE_INVALID", message: "Unsupported role" } }, 400);
            const target = users.find((u) => u.id === body.uid);
            if (target) {
              audits.unshift({
                id: `a${audits.length + 1}`, actor_id: "u-nadia-002", action: role === NO_ROLE ? "admin_role_removed" : "admin_role_assigned",
                target_type: "user", target_id: target.id, reason: role, created_at: new Date().toISOString(),
                metadata: { previous_role: target.admin_role ?? "none", new_role: role, result: "success" },
              });
              target.admin_role = role === NO_ROLE ? null : role;
            }
            return json({ success: true, data: { uid: body.uid, role: role === NO_ROLE ? null : role } });
          }
          case "admin_set_disabled": {
            const target = users.find((u) => u.id === body.uid);
            if (target) target.disabled = body.disabled === true;
            return json({ success: true, data: true });
          }
          default:
            return json({ success: false, error: { code: "UNKNOWN_ACTION", message: "UNKNOWN_ACTION" } }, 400);
        }
      }
      return real(input as RequestInfo, init);
    }) as typeof window.fetch;

    setReady(true);
    return () => { window.fetch = real; };
  }, []);
  return ready;
}

export function AdminPreview() {
  const ready = useMockTransport();
  const [tab, setTab] = useState<"overview" | "users" | "audit">("users");

  if (!ready) return null;

  return (
    <div className="min-h-screen bg-bg p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-2 text-xs text-warning">
          Development preview — the real components rendered against mock data. Not available in production.
        </div>

        <header className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">Matrix · Admin control centre</p>
            <h1 className="mt-1 font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">Admin control centre</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">Manage users, permissions, security and AI infrastructure.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1 text-[11px] font-medium text-accent">Super administrator</span>
            <SystemStatusPill />
          </div>
        </header>

        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <AdminNav codes={CODES} />
          <div className="min-w-0 flex-1 space-y-5">
            <div className="flex flex-wrap gap-2">
              {(["overview", "users", "audit"] as const).map((k) => (
                <Button key={k} variant={tab === k ? "primary" : "outline"} className="!min-h-9 text-xs capitalize" onClick={() => setTab(k)}>
                  {k === "audit" ? "Audit log" : k}
                </Button>
              ))}
            </div>

            {tab === "overview" ? (
              <div className="space-y-5">
                <SystemPulse metrics={[{ label: "Users", value: String(USERS.length) }, { label: "Admins", value: "3" }, { label: "Audit", value: String(AUDITS.length) }]} />
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {[
                    { label: "Registered users", value: USERS.length, hint: "profiles" },
                    { label: "Accounts with admin roles", value: 3, hint: "role assignments" },
                    { label: "Audit entries", value: AUDITS.length, hint: "all time" },
                  ].map((s) => (
                    <Card key={s.label}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">{s.label}</p>
                      <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">{s.value}</p>
                      <p className="mt-1 font-mono text-[11px] text-ink-3">{s.hint}</p>
                    </Card>
                  ))}
                </div>
              </div>
            ) : tab === "users" ? (
              <UsersTab codes={CODES} />
            ) : (
              <AuditLog codes={CODES} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
