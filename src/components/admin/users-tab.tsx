"use client";

import { useEffect, useMemo, useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { formatDate } from "@/lib/utils";

type AdminUser = {
  id: string; email: string; full_name: string; created_at: string; last_sign_in_at: string | null;
  age_verified: boolean; country: string; consent_status: string; identity_status: string;
};

export function UsersTab({ codes }: { codes: string[] }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const canManage = codes.includes("users.view");

  useEffect(() => {
    if (!codes.includes("users.view")) return;
    rpc<AdminUser[]>("admin_list_users")
      .then((data) => setUsers(data ?? []))
      .catch((err) => setError(err instanceof RpcCallError ? err.code : "LOAD_FAILED"));
  }, [codes]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!users) return [];
    if (!needle) return users;
    return users.filter((u) => `${u.full_name} ${u.email} ${u.country}`.toLowerCase().includes(needle));
  }, [users, q]);

  async function setRole(uid: string, role: string) {
    setBusy(uid);
    try {
      await rpc("admin_set_role", { uid, role });
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "ROLE_FAILED");
    }
    setBusy(null);
  }

  async function disable(uid: string, disabled: boolean) {
    setBusy(uid);
    try {
      await rpc("admin_set_disabled", { uid, disabled });
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "DISABLE_FAILED");
    }
    setBusy(null);
  }

  if (!codes.includes("users.view")) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>users.view</strong> permission to see users.</p></Card>;
  }
  if (error) return <Card><p className="text-sm text-danger">{error}</p></Card>;
  if (!users) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading users…</Card>;

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="font-bold text-ink">Users ({visible.length})</h2>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email" className="sm:max-w-xs" />
      </div>
      <div className="mt-3 grid gap-3 lg:hidden">
        {visible.map((u) => (
          <div key={u.id} className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
            <p className="font-medium text-ink">{u.full_name || "—"}</p>
            <p className="text-xs text-ink-3">{u.email}</p>
            <p className="mt-1 text-xs text-ink-3">Joined {formatDate(u.created_at)} · {u.age_verified ? "age verified" : "age pending"}</p>
            {canManage ? <UserActions uid={u.id} busy={busy === u.id} onRole={setRole} onDisable={disable} /> : null}
          </div>
        ))}
      </div>
      <div className="no-scrollbar mt-3 hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase text-ink-3">
              <th className="py-2 pr-3">Name / email</th>
              <th className="py-2 pr-3">Joined</th>
              <th className="py-2 pr-3">Last sign-in</th>
              <th className="py-2 pr-3">Age</th>
              <th className="py-2 pr-3">Consent</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => (
              <tr key={u.id} className="border-b border-border">
                <td className="py-2.5 pr-3">
                  <p className="font-medium text-ink">{u.full_name || "—"}</p>
                  <p className="text-xs text-ink-3">{u.email}</p>
                </td>
                <td className="py-2.5 pr-3 text-ink-3">{formatDate(u.created_at)}</td>
                <td className="py-2.5 pr-3 text-ink-3">{u.last_sign_in_at ? formatDate(u.last_sign_in_at) : "never"}</td>
                <td className="py-2.5 pr-3">
                  {u.age_verified
                    ? <Badge className="border-success/30 bg-success-soft text-success">verified</Badge>
                    : <Badge className="border-warning/30 bg-warning-soft text-warning">pending</Badge>}
                </td>
                <td className="py-2.5 pr-3"><Badge className="border-border bg-surface capitalize text-ink-2">{u.consent_status}</Badge></td>
                <td className="py-2.5"><UserActions uid={u.id} busy={busy === u.id} onRole={setRole} onDisable={disable} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-3">
        PII columns are never listed here. Role and disable require super_admin and are audited.
      </p>
    </Card>
  );
}

function UserActions({
  uid, busy, onRole, onDisable,
}: {
  uid: string;
  busy: boolean;
  onRole: (uid: string, role: string) => void;
  onDisable: (uid: string, disabled: boolean) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 lg:mt-0">
      <Select defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) onRole(uid, e.target.value); }} className="!min-h-9 !py-1 text-xs">
        <option value="">Role…</option>
        <option value="super_admin">super_admin</option>
        <option value="security_admin">security_admin</option>
        <option value="content_admin">content_admin</option>
        <option value="support_admin">support_admin</option>
        <option value="auditor">auditor</option>
        <option value="none">remove admin</option>
      </Select>
      <Button variant="outline" className="!min-h-9 !px-3 !py-1 text-xs" disabled={busy} onClick={() => onDisable(uid, true)}>Disable</Button>
      <Button variant="ghost" className="!min-h-9 !px-3 !py-1 text-xs" disabled={busy} onClick={() => onDisable(uid, false)}>Enable</Button>
    </div>
  );
}
