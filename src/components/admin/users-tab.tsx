"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download, RefreshCw, Search, ShieldCheck, Slash, UserCog, X } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Select, TableSkeleton } from "@/components/ui";
import { ConfirmDialog, Modal, StatusMessage } from "@/components/ui-interactive";
import { errorCodeOf, mapAdminError, type AdminErrorView } from "@/lib/admin-errors";
import { NO_ROLE, permissionLabel } from "@/lib/roles";
import { ALL_ADMIN_PERMISSION_CODES } from "@/lib/admin-rbac";
import { formatDate } from "@/lib/utils";

type AdminUser = {
  id: string; email: string; full_name: string; created_at: string; last_sign_in_at: string | null;
  age_verified: boolean; country: string; consent_status: string; identity_status: string;
  disabled?: boolean; admin_role?: string | null;
};

type RoleOption = { id: string; label: string; description: string; tone: string; permissions: string[] };
type RoleCatalog = { roles: RoleOption[]; permissions: string[]; none: { id: string; label: string } };

const TONE_CLASS: Record<string, string> = {
  primary: "border-accent/40 bg-accent-soft text-accent",
  secondary: "border-border-strong bg-surface-2 text-ink-2",
  warning: "border-warning/40 bg-warning-soft text-warning",
  muted: "border-border bg-surface-2 text-ink-3",
};

export function UsersTab({ codes }: { codes: string[] }) {
  const canView = codes.includes("users.view");
  const canManageRoles = codes.includes("admin.manage");

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null);
  const [error, setError] = useState<AdminErrorView | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [confirm, setConfirm] = useState<{ user: AdminUser; disabled: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    setError(null);
    setUsers(null);
    try {
      const [list, cat] = await Promise.all([
        rpc<AdminUser[]>("admin_list_users"),
        rpc<RoleCatalog>("admin_role_catalog").catch(() => null),
      ]);
      setUsers(list ?? []);
      if (cat) setCatalog(cat);
    } catch (err) {
      const view = mapAdminError(errorCodeOf(err, "LOAD_FAILED"));
      console.error("[MATRIX admin] loading users failed", view.code, err);
      setError(view);
    }
  }, [canView]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (users ?? []).filter((u) => {
      if (needle && !`${u.full_name} ${u.email} ${u.country}`.toLowerCase().includes(needle)) return false;
      if (roleFilter !== "all") {
        const role = u.admin_role ?? NO_ROLE;
        if (role !== roleFilter) return false;
      }
      if (statusFilter === "active" && u.disabled) return false;
      if (statusFilter === "suspended" && !u.disabled) return false;
      return true;
    });
  }, [users, q, roleFilter, statusFilter]);

  const filtersActive = q.trim() !== "" || roleFilter !== "all" || statusFilter !== "all";
  function clearFilters() { setQ(""); setRoleFilter("all"); setStatusFilter("all"); }

  async function saveRole(user: AdminUser, role: string) {
    setBusy(user.id);
    try {
      await rpc<{ role: string | null }>("admin_set_role", { uid: user.id, role });
      setUsers((prev) => prev?.map((u) => (u.id === user.id ? { ...u, admin_role: role === NO_ROLE ? null : role } : u)) ?? prev);
      setEditing(null);
      setToast({ tone: "success", text: `Role updated for ${user.full_name || user.email}.` });
    } catch (err) {
      const view = mapAdminError(errorCodeOf(err, "ROLE_UPDATE_FAILED"));
      console.error("[MATRIX admin] role update failed", view.code, err);
      setToast({ tone: "danger", text: `${view.title} — ${view.detail}` });
    } finally {
      setBusy(null);
    }
  }

  async function setDisabled(user: AdminUser, disabled: boolean) {
    setBusy(user.id);
    try {
      await rpc("admin_set_disabled", { uid: user.id, disabled });
      setUsers((prev) => prev?.map((u) => (u.id === user.id ? { ...u, disabled } : u)) ?? prev);
      setConfirm(null);
      setToast({ tone: "success", text: `${user.full_name || user.email} ${disabled ? "suspended" : "reactivated"}.` });
    } catch (err) {
      const view = mapAdminError(errorCodeOf(err, "SUSPEND_FAILED"));
      console.error("[MATRIX admin] suspend failed", view.code, err);
      setToast({ tone: "danger", text: `${view.title} — ${view.detail}` });
    } finally {
      setBusy(null);
    }
  }

  function exportCsv() {
    const head = ["name", "email", "role", "status", "created", "last_active"];
    const rows = visible.map((u) => [
      u.full_name, u.email, u.admin_role ?? "user", u.disabled ? "suspended" : "active",
      u.created_at, u.last_sign_in_at ?? "",
    ]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `matrix-users-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  if (!canView) {
    return (
      <Card>
        <EmptyState
          title="You don't have access to user management"
          body="This section requires the user directory permission. Ask a super administrator to grant it."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <Card className="!p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search users by name, email or country…"
              aria-label="Search users"
              className="!pl-9"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <Select aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="!min-h-10 text-sm">
              <option value="all">All roles</option>
              <option value={NO_ROLE}>Standard user</option>
              {(catalog?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select>
            <Select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="!min-h-10 text-sm">
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </Select>
            <Button variant="outline" className="!min-h-10" onClick={() => void load()} aria-label="Refresh user list">
              <RefreshCw aria-hidden className="h-4 w-4" /> Refresh
            </Button>
            <Button variant="outline" className="!min-h-10" onClick={exportCsv} disabled={!visible.length}>
              <Download aria-hidden className="h-4 w-4" /> Export
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-3">
            {users ? `${visible.length} / ${users.length} users` : "loading…"}
          </p>
          {toast ? <StatusMessage tone={toast.tone}>{toast.tone === "success" ? <Check aria-hidden className="h-3.5 w-3.5" /> : <X aria-hidden className="h-3.5 w-3.5" />}{toast.text}</StatusMessage> : null}
        </div>
      </Card>

      {error ? (
        <ErrorState title={error.title} detail={error.detail} code={error.code} onRetry={() => void load()} />
      ) : !users ? (
        <Card><TableSkeleton rows={6} cols={5} label="Loading users…" /></Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title="No users found"
            body={filtersActive ? "Try changing your search or filters." : "No accounts have been created yet."}
            action={filtersActive ? <Button variant="outline" className="!min-h-9 text-xs" onClick={clearFilters}>Clear filters</Button> : undefined}
          />
        </Card>
      ) : (
        <>
          {/* mobile cards */}
          <div className="grid gap-3 xl:hidden">
            {visible.map((u) => (
              <Card key={u.id} className="row-in !p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink">{u.full_name || "Unnamed user"}</p>
                    <p className="truncate font-mono text-xs text-ink-3">{u.email}</p>
                  </div>
                  <RoleBadge role={u.admin_role} catalog={catalog} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-3">
                  <div><dt className="text-ink-3">Status</dt><dd className="text-ink-2">{u.disabled ? "Suspended" : "Active"}</dd></div>
                  <div><dt className="text-ink-3">Created</dt><dd className="text-ink-2">{formatDate(u.created_at)}</dd></div>
                  <div><dt className="text-ink-3">Last active</dt><dd className="text-ink-2">{u.last_sign_in_at ? formatDate(u.last_sign_in_at) : "Never"}</dd></div>
                  <div><dt className="text-ink-3">Age check</dt><dd className="text-ink-2">{u.age_verified ? "Verified" : "Pending"}</dd></div>
                </dl>
                <RowActions
                  user={u} busy={busy === u.id} canManageRoles={canManageRoles}
                  onEdit={() => setEditing(u)} onToggle={(dis) => setConfirm({ user: u, disabled: dis })}
                />
              </Card>
            ))}
          </div>

          {/* desktop table */}
          <Card className="hidden !p-0 xl:block">
            <div className="no-scrollbar overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <caption className="sr-only">Platform users with role, status and administrative actions</caption>
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-wider text-ink-3">
                    <th scope="col" className="px-4 py-3">User</th>
                    <th scope="col" className="px-4 py-3">Email</th>
                    <th scope="col" className="px-4 py-3">Role</th>
                    <th scope="col" className="px-4 py-3">Status</th>
                    <th scope="col" className="px-4 py-3">Created</th>
                    <th scope="col" className="px-4 py-3">Last active</th>
                    <th scope="col" className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((u) => (
                    <tr key={u.id} className="row-in border-b border-border transition-colors last:border-0 hover:bg-surface-2/60">
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink">{u.full_name || "Unnamed user"}</p>
                        <p className="font-mono text-[11px] text-ink-3">{u.id.slice(0, 10)}</p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-ink-2">{u.email || "—"}</td>
                      <td className="px-4 py-3"><RoleBadge role={u.admin_role} catalog={catalog} /></td>
                      <td className="px-4 py-3">
                        {u.disabled
                          ? <Badge className="border-danger/30 bg-danger-soft text-danger">Suspended</Badge>
                          : <Badge className="border-success/30 bg-success-soft text-success">Active</Badge>}
                      </td>
                      <td className="px-4 py-3 text-ink-3">{formatDate(u.created_at)}</td>
                      <td className="px-4 py-3 text-ink-3">{u.last_sign_in_at ? formatDate(u.last_sign_in_at) : "Never"}</td>
                      <td className="px-4 py-3">
                        <RowActions
                          align="right" user={u} busy={busy === u.id} canManageRoles={canManageRoles}
                          onEdit={() => setEditing(u)} onToggle={(dis) => setConfirm({ user: u, disabled: dis })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <p className="px-1 font-mono text-[11px] text-ink-3">
        Personal data columns are never listed here. Role and suspension changes require the admin.manage permission and are written to the audit log.
      </p>

      {editing ? (
        <RoleEditor
          user={editing}
          catalog={catalog}
          busy={busy === editing.id}
          canManageRoles={canManageRoles}
          onClose={() => setEditing(null)}
          onSave={(role) => void saveRole(editing, role)}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(confirm)}
        busy={Boolean(confirm && busy === confirm.user.id)}
        title={confirm?.disabled ? "Suspend this account?" : "Reactivate this account?"}
        description={
          confirm?.disabled
            ? `${confirm?.user.full_name || confirm?.user.email} will be signed out everywhere and blocked from signing in until reactivated.`
            : `${confirm?.user.full_name || confirm?.user.email} will be able to sign in again immediately.`
        }
        confirmLabel={confirm?.disabled ? "Suspend account" : "Reactivate"}
        danger={Boolean(confirm?.disabled)}
        onClose={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void setDisabled(confirm.user, confirm.disabled); }}
      />
    </div>
  );
}

function RoleBadge({ role, catalog }: { role: string | null | undefined; catalog: RoleCatalog | null }) {
  if (!role) return <Badge className="border-border bg-surface-2 text-ink-3">Standard user</Badge>;
  const def = catalog?.roles.find((r) => r.id === role);
  return <Badge className={TONE_CLASS[def?.tone ?? "secondary"]}>{def?.label ?? role}</Badge>;
}

function RowActions({
  user, busy, canManageRoles, onEdit, onToggle, align,
}: {
  user: AdminUser; busy: boolean; canManageRoles: boolean;
  onEdit: () => void; onToggle: (disabled: boolean) => void; align?: "right";
}) {
  return (
    <div className={`mt-3 flex flex-wrap items-center gap-2 xl:mt-0 ${align === "right" ? "xl:justify-end" : ""}`}>
      <Button
        variant="outline" className="!min-h-9 !px-3 !py-1 text-xs" disabled={busy || !canManageRoles}
        onClick={onEdit}
        title={canManageRoles ? "Edit role" : "Requires the admin.manage permission"}
      >
        <UserCog aria-hidden className="h-3.5 w-3.5" /> Edit role
      </Button>
      {user.disabled ? (
        <Button variant="ghost" className="!min-h-9 !px-3 !py-1 text-xs" disabled={busy} onClick={() => onToggle(false)}>
          <ShieldCheck aria-hidden className="h-3.5 w-3.5" /> Reactivate
        </Button>
      ) : (
        <Button variant="ghost" className="!min-h-9 !px-3 !py-1 text-xs text-danger" disabled={busy} onClick={() => onToggle(true)}>
          <Slash aria-hidden className="h-3.5 w-3.5" /> Suspend
        </Button>
      )}
    </div>
  );
}

function RoleEditor({
  user, catalog, busy, canManageRoles, onClose, onSave,
}: {
  user: AdminUser; catalog: RoleCatalog | null; busy: boolean; canManageRoles: boolean;
  onClose: () => void; onSave: (role: string) => void;
}) {
  const current = user.admin_role ?? NO_ROLE;
  const [selected, setSelected] = useState(current);
  const all = catalog?.permissions ?? [...ALL_ADMIN_PERMISSION_CODES];
  const granted = new Set(catalog?.roles.find((r) => r.id === selected)?.permissions ?? []);
  const def = catalog?.roles.find((r) => r.id === selected);

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit user role"
      description="Changing a role takes effect immediately and is recorded in the audit log."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => onSave(selected)} disabled={busy || selected === current || !canManageRoles}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <p className="font-semibold text-ink">{user.full_name || "Unnamed user"}</p>
          <p className="font-mono text-xs text-ink-3">{user.email}</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="role-select" className="block text-[13px] font-medium text-ink-2">Role</label>
          <Select id="role-select" data-autofocus value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!canManageRoles}>
            <option value={NO_ROLE}>{catalog?.none.label ?? "Standard user (no admin access)"}</option>
            {(catalog?.roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
          <p className="text-xs text-ink-3">{def?.description ?? "No administrative access. Chat, workspace and personal history only."}</p>
        </div>

        <div>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-ink-3">Permissions preview</p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {all.map((code) => {
              const on = granted.has(code);
              return (
                <li key={code} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${on ? "border-success/30 bg-success-soft text-success" : "border-border bg-surface text-ink-3"}`}>
                  <span aria-hidden>{on ? "✓" : "○"}</span>
                  <span className="truncate">{permissionLabel(code)}</span>
                  <span className="sr-only">{on ? "granted" : "not granted"}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {!canManageRoles ? (
          <p className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
            You can view roles but only a super administrator can change them.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
