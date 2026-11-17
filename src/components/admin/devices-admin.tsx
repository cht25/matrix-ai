"use client";

// =============================================================================
// QORVYNA — admin device dashboard (Phase 7).
//
// Lists every paired device with online state, last-seen, pairing status and
// link history. Admins can disable, block and revoke — always with a written
// reason, always audited. The server re-checks permissions on every call; this
// component only decides what to *show*.
//
// Nothing here can reveal a pairing secret: the API returns a boolean
// `has_credential` and never the token or its hash.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Loader2, RefreshCw, Search, ShieldOff, Undo2, Wifi, WifiOff } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner } from "@/components/ui";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { STATUS_LABEL } from "@/lib/devices/model";

type AdminDeviceRow = {
  id: string;
  owner_uid: string;
  device_name: string;
  platform: string;
  os: string;
  app_version: string;
  role: string;
  status: string;
  online: boolean;
  registered_at: string;
  last_seen_at: string;
  last_ip: string;
  location: string;
  has_credential: boolean;
  suspended: boolean;
  blocked: boolean;
  revoked: boolean;
  links: number;
};

type ListResponse = { devices: AdminDeviceRow[]; total: number; counts: Record<string, number> };

const PLATFORMS = ["all", "android", "windows", "web", "ios", "macos", "linux"];
const STATUSES = ["all", "online", "offline", "pending", "disconnected", "revoked"];

function relative(iso: string): string {
  if (!iso) return "never";
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta) || delta < 0) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function DevicesAdmin({ codes }: { codes: string[] }) {
  const toast = useToast();
  const canRead = codes.includes("security.view");
  const canWrite = canRead && codes.includes("users.view");

  const [rows, setRows] = useState<AdminDeviceRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [target, setTarget] = useState<{ device: AdminDeviceRow; action: string } | null>(null);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [history, setHistory] = useState<Array<{ id: string; a: string; b: string; status: string; created_at: string; revoked_at: string }> | null>(null);

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    try {
      const result = await rpc<ListResponse>("admin_devices_list", { search, status: status === "all" ? "" : status, platform: platform === "all" ? "" : platform, online_only: onlineOnly });
      setRows(result?.devices ?? []);
      setCounts(result?.counts ?? {});
      setTotal(result?.total ?? 0);
      setError(null);
    } catch (cause) {
      setRows(null);
      setError(cause instanceof RpcCallError ? cause.message : "Devices could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [canRead, search, status, platform, onlineOnly]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = useMemo(
    () => [
      { label: "Devices", value: total },
      { label: "Online", value: counts.online ?? 0 },
      { label: "Offline", value: counts.offline ?? 0 },
      { label: "Pending", value: counts.pending ?? 0 },
      { label: "Revoked", value: counts.revoked ?? 0 },
    ],
    [counts, total],
  );

  async function submitModeration() {
    if (!target) return;
    if (reason.trim().length < 4) {
      toast("Write a short reason — moderation actions are audited.");
      return;
    }
    setWorking(true);
    try {
      await rpc("admin_device_moderate", { device_id: target.device.id, action: target.action, reason: reason.trim() });
      toast(`Device ${target.action === "enable" ? "re-enabled" : target.action === "unblock" ? "unblocked" : `${target.action}d`}.`);
      setTarget(null);
      setReason("");
      await load();
    } catch (cause) {
      toast(cause instanceof RpcCallError && cause.code === "FORBIDDEN" ? "You do not have permission for that action." : "The action failed — nothing was changed.");
    } finally {
      setWorking(false);
    }
  }

  async function loadHistory() {
    try {
      setHistory(await rpc("admin_pairing_history", { limit: 100 }));
    } catch {
      setHistory([]);
      toast("Pairing history could not be loaded.");
    }
  }

  if (!canRead) {
    return (
      <Card>
        <p className="text-sm text-ink-2">
          You need the <strong>security.view</strong> permission to see devices. Moderating also needs{" "}
          <strong>users.view</strong>.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {summary.map((item) => (
          <Card key={item.label} className="py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">{item.label}</p>
            <p className="mt-0.5 text-xl font-semibold text-ink">{item.value}</p>
          </Card>
        ))}
      </div>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
          <Field label="Search" htmlFor="device-search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input
                id="device-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Device, user id, IP, version…"
                className="pl-8"
              />
            </div>
          </Field>
          </div>
          <Field label="Status" htmlFor="device-status">
            <Select id="device-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              {STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All statuses" : STATUS_LABEL[option as keyof typeof STATUS_LABEL] ?? option}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Platform" htmlFor="device-platform">
            <Select id="device-platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>
              {PLATFORMS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All platforms" : option}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-2">
            <input type="checkbox" checked={onlineOnly} onChange={(event) => setOnlineOnly(event.target.checked)} />
            Online only
          </label>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />} Refresh
          </Button>
          <Button type="button" variant="ghost" onClick={() => void loadHistory()}>
            Pairing history
          </Button>
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}
        {!canWrite ? (
          <Alert tone="info">
            Read-only: you can inspect devices but not disable, block or revoke them (needs <strong>users.view</strong>).
          </Alert>
        ) : null}

        {rows === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-ink-2">
            <Spinner /> Loading devices…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No devices match" body="Adjust the search or filters. Devices appear here after their first pairing." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-[11px] uppercase tracking-wide text-ink-3">
                  <th className="py-2 pr-3 font-medium">Device</th>
                  <th className="py-2 pr-3 font-medium">Owner</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Last seen</th>
                  <th className="py-2 pr-3 font-medium">Credential</th>
                  <th className="py-2 pr-3 font-medium">Links</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60 align-top last:border-0">
                    <td className="py-2 pr-3">
                      <p className="font-medium text-ink">{row.device_name}</p>
                      <p className="text-[11.5px] text-ink-3">
                        {row.platform} · {row.os || "unknown OS"} · {row.app_version || "no version"}
                      </p>
                      <p className="font-mono text-[10.5px] text-ink-3">{row.id}</p>
                    </td>
                    <td className="py-2 pr-3">
                      <p className="font-mono text-[11.5px] text-ink-2">{row.owner_uid.slice(0, 12)}…</p>
                      <p className="text-[11px] text-ink-3">{row.role}</p>
                    </td>
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-1.5">
                        {row.online ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-ink-3" />}
                        <Badge>{STATUS_LABEL[row.status as keyof typeof STATUS_LABEL] ?? row.status}</Badge>
                      </span>
                      {row.blocked ? <p className="mt-1 text-[11px] font-medium text-rose-500">Blocked</p> : null}
                      {row.suspended ? <p className="mt-1 text-[11px] text-amber-500">Disabled</p> : null}
                    </td>
                    <td className="py-2 pr-3 text-[12px] text-ink-2">{relative(row.last_seen_at)}</td>
                    <td className="py-2 pr-3 text-[12px]">
                      {row.has_credential ? <span className="text-ink-2">Present (hash only)</span> : <span className="text-ink-3">None</span>}
                    </td>
                    <td className="py-2 pr-3 text-[12px] text-ink-2">{row.links}</td>
                    <td className="py-2">
                      {row.revoked ? (
                        <span className="text-[12px] text-ink-3">Revoked</span>
                      ) : canWrite ? (
                        <div className="flex flex-wrap gap-1">
                          <Button type="button" variant="ghost" onClick={() => setTarget({ device: row, action: row.suspended ? "enable" : "disable" })}>
                            {row.suspended ? <Undo2 className="mr-1 h-3.5 w-3.5" /> : <ShieldOff className="mr-1 h-3.5 w-3.5" />}
                            {row.suspended ? "Enable" : "Disable"}
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => setTarget({ device: row, action: row.blocked ? "unblock" : "block" })}>
                            <Ban className="mr-1 h-3.5 w-3.5" /> {row.blocked ? "Unblock" : "Block"}
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => setTarget({ device: row, action: "revoke" })}>
                            Revoke
                          </Button>
                        </div>
                      ) : (
                        <span className="text-[12px] text-ink-3">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {history ? (
        <Card>
          <h2 className="font-semibold text-ink">Cross-account pairing history</h2>
          <p className="mt-0.5 text-xs text-ink-3">Which accounts linked, when, and whether the link is still active.</p>
          {history.length === 0 ? (
            <p className="mt-3 text-sm text-ink-3">No cross-account links yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {history.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="font-mono text-[11.5px] text-ink-2">
                    {entry.a.slice(0, 10)}… ↔ {entry.b.slice(0, 10)}…
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge>{entry.status}</Badge>
                    <span className="text-[11.5px] text-ink-3">{entry.created_at ? new Date(entry.created_at).toLocaleString() : ""}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <Modal
        open={target !== null}
        onClose={() => {
          setTarget(null);
          setReason("");
        }}
        title={
          target
            ? `${target.action === "enable" ? "Enable" : target.action === "unblock" ? "Unblock" : target.action.charAt(0).toUpperCase() + target.action.slice(1)} device`
            : "Moderate device"
        }
      >
        {target ? (
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-ink-2">
              <strong className="text-ink">{target.device.device_name}</strong> ({target.device.platform}) owned by{" "}
              <span className="font-mono">{target.device.owner_uid.slice(0, 12)}…</span>
            </p>
            {target.action === "revoke" ? (
              <Alert tone="danger">
                Revoking removes this device&apos;s credential and ends every cross-account link it belongs to. The owner
                will have to pair again.
              </Alert>
            ) : null}
            <Field label="Reason" htmlFor="moderation-reason" hint="Stored in the audit log with your admin id.">
              <Input
                id="moderation-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Reported stolen by the account owner"
                maxLength={400}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => { setTarget(null); setReason(""); }}>
                Cancel
              </Button>
              <Button type="button" disabled={working || reason.trim().length < 4} onClick={() => void submitModeration()}>
                {working ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null} Confirm
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
