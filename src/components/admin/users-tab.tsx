"use client";

import { useEffect, useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Badge, Card, Spinner } from "@/components/ui";
import { formatDate } from "@/lib/utils";

type AdminUser = {
  id: string; email: string; full_name: string; created_at: string; last_sign_in_at: string | null;
  age_verified: boolean; country: string; consent_status: string; identity_status: string;
};

export function UsersTab({ codes }: { codes: Set<string> }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!codes.has("users.view")) return;
    rpc<AdminUser[]>("admin_list_users")
      .then((data) => setUsers(data ?? []))
      .catch((err) => setError(err instanceof RpcCallError ? err.code : "LOAD_FAILED"));
  }, [codes]);

  if (!codes.has("users.view")) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>users.view</strong> permission to see users.</p></Card>;
  }
  if (error) return <Card><p className="text-sm text-danger">{error}</p></Card>;
  if (!users) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading users…</Card>;

  return (
    <Card>
      <h2 className="font-bold text-ink">Users ({users.length})</h2>
      <div className="no-scrollbar mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase text-ink-3">
              <th className="py-2 pr-3">Name / email</th>
              <th className="py-2 pr-3">Joined</th>
              <th className="py-2 pr-3">Last sign-in</th>
              <th className="py-2 pr-3">Age verified</th>
              <th className="py-2 pr-3">Consent</th>
              <th className="py-2">Identity</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
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
                <td className="py-2.5 pr-3">
                  <Badge className="border-border bg-surface capitalize text-ink-2">{u.consent_status}</Badge>
                </td>
                <td className="py-2.5 capitalize text-ink-3">{u.identity_status.replaceAll("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-3">
        PII columns (address, phone, documents) are never listed here — they require the separate
        <strong> users.view_pii</strong> permission and are only accessible through audited flows.
      </p>
    </Card>
  );
}
