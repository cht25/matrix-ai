"use client";

// Device hub — "Register as Parent" / "Register as Child", approved QR pairing
// and the device dashboard. Everything shown here comes from the server; a
// device only appears once it has really completed pairing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, Clock, Copy, Loader2, Monitor, Pencil, Plug, QrCode, ScanLine, ShieldCheck, Smartphone, Tablet, Trash2, Unplug, Users, Watch, X,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input } from "@/components/ui";
import { Modal, ConfirmModal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { QrScanner } from "@/components/devices/qr-scanner";
import {
  DEFAULT_CHILD_PERMISSIONS, DEVICE_PERMISSIONS, PERMISSION_INFO, STATUS_LABEL, describeUserAgent, deviceCapabilities, formatManualCode, normalizeManualCode,
  type ConnectionStatus, type DevicePermission, type DeviceRole, type HubDevice, type PairingRequestView,
} from "@/lib/devices/model";

const KEY = { client: "matrix.device.client_id", role: "matrix.device.role", parent: "matrix.device.parent_id", child: "matrix.device.child", pending: "matrix.device.pending" };

type Pairing = { challenge_id: string; qr_payload: string; qr_data_url: string; manual_code: string; expires_at: string };
type Pending = { challenge_id: string; claim_secret: string; decide_by: string };
type ChildLink = { device_id: string; access_token: string; device_name: string; parent: { id: string; device_name: string } | null };
type ClaimResult =
  | { status: "requested" | "denied" | "expired" }
  | { status: "approved"; device: HubDevice; parent: { id: string; device_name: string } | null; access_token: string };

const ERRORS: Record<string, string> = {
  PAIRING_EXPIRED: "That pairing code has expired. Ask the Parent device for a new one.",
  PAIRING_USED: "That pairing code was already used. Ask the Parent device for a new one.",
  PAIRING_INVALID: "That isn't a valid MATRIX pairing code. Check it and try again.",
  PAIRING_ACCOUNT_MISMATCH: "That code belongs to a different MATRIX account. Sign in to the same account on both devices. To link another person's device, use Family.",
  PAIRING_RATE_LIMITED: "Too many pairing attempts. Wait a few minutes and try again.",
  PAIRING_NOT_PENDING: "That request was already answered.",
  PARENT_DEVICE_REQUIRED: "Register this device as a Parent first.",
  DEVICE_REVOKED: "This device's access was revoked. Register it again to continue.",
  PAIRING_NOT_CONFIGURED: "Device pairing isn't set up on this server yet.",
  UNAUTHENTICATED: "Your session expired. Sign in again.",
};
const explain = (error: unknown, fallback: string) => (error instanceof RpcCallError ? ERRORS[error.code] ?? fallback : fallback);

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: the choice simply won't persist */ }
}
function clientId(): string {
  let id = read<string>(KEY.client);
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    write(KEY.client, id);
  }
  return id;
}

/** rpc authenticated with this Child device's own credential (its heartbeat). */
async function deviceRpc<T>(token: string, action: string): Promise<T> {
  const res = await fetch("/api/rpc", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action }) });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string } | string } | null;
  if (!res.ok) throw new RpcCallError(typeof body?.error === "string" ? body.error : body?.error?.code ?? "INTERNAL", res.status);
  return body?.data as T;
}

function DeviceIcon({ device, size = 18 }: { device: Pick<HubDevice, "device_type" | "platform">; size?: number }) {
  const kind = `${device.device_type} ${device.platform}`.toLowerCase();
  if (/watch|wear/.test(kind)) return <Watch size={size} />;
  if (/tablet/.test(kind)) return <Tablet size={size} />;
  if (/phone|android|ios/.test(kind)) return <Smartphone size={size} />;
  return <Monitor size={size} />;
}

const STATUS_TONE: Record<ConnectionStatus, string> = {
  online: "!border-success/40 !text-success",
  offline: "!text-ink-3",
  disconnected: "!border-warning/40 !text-warning",
  pending: "!border-warning/40 !text-warning",
  revoked: "!border-danger/40 !text-danger",
};

function when(iso: string): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function PermissionList({ value, onChange, disabled }: { value: DevicePermission[]; onChange: (next: DevicePermission[]) => void; disabled?: boolean }) {
  return (
    <ul className="space-y-1.5">
      {DEVICE_PERMISSIONS.map((permission) => {
        const checked = value.includes(permission);
        return (
          <li key={permission}>
            <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-surface-2/50 p-2.5", disabled && "cursor-not-allowed opacity-60")}>
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(checked ? value.filter((item) => item !== permission) : [...value, permission])}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{PERMISSION_INFO[permission].label}</span>
                <span className="block text-xs text-ink-3">{PERMISSION_INFO[permission].detail}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export function DeviceHub() {
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<DeviceRole | null>(null);
  const [parentId, setParentId] = useState("");
  const [child, setChild] = useState<ChildLink | null>(null);
  const [childStatus, setChildStatus] = useState<ConnectionStatus | "unknown">("unknown");
  const [pending, setPending] = useState<Pending | null>(null);
  const [devices, setDevices] = useState<HubDevice[] | null>(null);
  const [requests, setRequests] = useState<PairingRequestView[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [manual, setManual] = useState("");
  const [approve, setApprove] = useState<{ request: PairingRequestView; name: string; permissions: DevicePermission[] } | null>(null);
  const [edit, setEdit] = useState<{ device: HubDevice; name: string; permissions: DevicePermission[] } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<HubDevice | null>(null);
  const requesting = useRef(false);

  const me = useMemo(() => (typeof navigator === "undefined" ? null : describeUserAgent(navigator.userAgent)), []);
  const currentId = role === "parent" ? parentId : child?.device_id ?? "";

  const loadDevices = useCallback(async () => {
    try {
      const current = read<string>(KEY.parent) ?? read<ChildLink>(KEY.child)?.device_id ?? null;
      setDevices(await rpc<HubDevice[]>("device_list", current ? { current_device_id: current } : {}));
    } catch (err) {
      setDevices((list) => list ?? []);
      setError(explain(err, "Devices couldn't be loaded. Check your connection and try again."));
    }
  }, []);

  // Restore this device's saved role without a layout jump.
  useEffect(() => {
    const savedRole = read<DeviceRole>(KEY.role);
    const savedChild = read<ChildLink>(KEY.child);
    setRole(savedRole === "parent" || savedRole === "child" ? savedRole : null);
    setParentId(read<string>(KEY.parent) ?? "");
    setChild(savedChild);
    setPending(read<Pending>(KEY.pending));
    setReady(true);
    void loadDevices();
  }, [loadDevices]);

  // Parent: keep the registration fresh (heartbeat) and watch for requests.
  useEffect(() => {
    if (role !== "parent" || !me) return;
    let cancelled = false;
    const beat = async () => {
      try {
        const device = await rpc<HubDevice>("device_register_parent", { client_id: clientId(), device_name: me.name, device_type: me.device_type, platform: me.platform, os: me.os });
        if (cancelled) return;
        if (device.id !== parentId) { setParentId(device.id); write(KEY.parent, device.id); }
        setRequests(await rpc<PairingRequestView[]>("device_pairing_requests"));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RpcCallError && err.code === "DEVICE_REVOKED") {
          write(KEY.role, null); write(KEY.parent, null); write(KEY.client, null);
          setRole(null); setParentId(""); setError(ERRORS.DEVICE_REVOKED);
        }
      }
    };
    void beat();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void beat(); }, pairing ? 3000 : 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [role, me, parentId, pairing]);

  // Parent: QR countdown; the QR disappears the moment it expires.
  useEffect(() => {
    if (!pairing) return;
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(pairing.expires_at).getTime() - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setPairing(null);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  // A scanned QR turns into a request; hide the QR so it can't be reused.
  useEffect(() => { if (pairing && requests.length) setPairing(null); }, [requests, pairing]);

  // Child: wait for the Parent's decision.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await rpc<ClaimResult>("device_pairing_claim", { challenge_id: pending.challenge_id, claim_secret: pending.claim_secret });
        if (cancelled || result.status === "requested") return;
        write(KEY.pending, null);
        setPending(null);
        if (result.status === "approved") {
          const link: ChildLink = { device_id: result.device.id, access_token: result.access_token, device_name: result.device.device_name, parent: result.parent };
          write(KEY.child, link); write(KEY.role, "child");
          setChild(link); setRole("child"); setChildStatus("online"); setError("");
          setNotice(`Connected${result.parent ? ` to ${result.parent.device_name}` : ""}.`);
          void loadDevices();
        } else {
          setError(result.status === "denied" ? "The Parent device declined this request." : "The request expired before the Parent approved it. Scan a new code to try again.");
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RpcCallError && err.status < 500 && err.status !== 429) {
          write(KEY.pending, null); setPending(null); setError(explain(err, "Pairing couldn't be completed. Scan a new code to try again."));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [pending, loadDevices]);

  // Child: heartbeat with the device's own credential — also detects revocation.
  useEffect(() => {
    if (role !== "child" || !child) return;
    let cancelled = false;
    const beat = async () => {
      try {
        const self = await deviceRpc<{ device: HubDevice; parent: ChildLink["parent"] }>(child.access_token, "device_self");
        if (cancelled) return;
        setChildStatus(self.device.status);
        if (self.device.device_name !== child.device_name || self.parent?.device_name !== child.parent?.device_name) {
          const next = { ...child, device_name: self.device.device_name, parent: self.parent };
          write(KEY.child, next); setChild(next);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RpcCallError && (err.status === 401 || err.status === 404)) {
          // The server refuses the credential: revoked, disconnected or expired.
          const list = await rpc<HubDevice[]>("device_list").catch(() => null);
          if (cancelled) return;
          const mine = list?.find((device) => device.id === child.device_id);
          if (list && !mine) {
            write(KEY.child, null); write(KEY.role, null);
            setChild(null); setRole(null); setError("This device was removed by the Parent. Register again to reconnect.");
          } else setChildStatus(mine?.status ?? "unknown");
        } else if (err instanceof RpcCallError && err.status === 403) setChildStatus("online"); // connected, without the "See devices" permission
        else setChildStatus("unknown");
      }
    };
    void beat();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void beat(); }, 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [role, child]);

  async function run(name: string, task: () => Promise<void>, fallback: string) {
    setBusy(name); setError(""); setNotice("");
    try { await task(); } catch (err) { setError(explain(err, fallback)); } finally { setBusy(""); }
  }

  const registerParent = () =>
    run("parent", async () => {
      if (!me) return;
      const device = await rpc<HubDevice>("device_register_parent", { client_id: clientId(), device_name: me.name, device_type: me.device_type, platform: me.platform, os: me.os });
      write(KEY.role, "parent"); write(KEY.parent, device.id);
      setParentId(device.id); setRole("parent");
      await loadDevices();
    }, "This device couldn't be registered. Try again.");

  const createQr = () =>
    run("qr", async () => {
      setPairing(await rpc<Pairing>("device_pairing_create", { parent_device_id: parentId }));
    }, "A pairing code couldn't be created. Try again.");

  const submitRequest = useCallback(async (input: { qr_payload?: string; manual_code?: string }) => {
    if (requesting.current || !me) return;
    requesting.current = true;
    setBusy("request"); setError(""); setNotice("");
    try {
      const result = await rpc<Pending & { status: string }>("device_pairing_request", { ...input, device_name: me.name, device_type: me.device_type, platform: me.platform, os: me.os });
      const next = { challenge_id: result.challenge_id, claim_secret: result.claim_secret, decide_by: result.decide_by };
      write(KEY.pending, next);
      setPending(next); setManual("");
    } catch (err) {
      setError(explain(err, "The pairing request couldn't be sent. Try again."));
    } finally {
      setBusy("");
      window.setTimeout(() => { requesting.current = false; }, 1500); // ignore the same QR being read repeatedly
    }
  }, [me]);

  const onScan = useCallback((text: string) => {
    if (!text.startsWith("matrix-pairing:v1.")) {
      if (!requesting.current) setError(text.startsWith("matrix-family-pair:") ? "That's a Family invitation code. Open Family to use it." : "That QR code isn't a MATRIX pairing code.");
      return;
    }
    void submitRequest({ qr_payload: text });
  }, [submitRequest]);

  const decide = (challengeId: string, ok: boolean, extra: Record<string, unknown> = {}) =>
    run(`decide:${challengeId}`, async () => {
      await rpc("device_pairing_decide", { challenge_id: challengeId, approve: ok, ...extra });
      setRequests((list) => list.filter((item) => item.challenge_id !== challengeId));
      setApprove(null);
      toast(ok ? "Device approved. It will connect in a moment." : "Request declined.");
      if (ok) window.setTimeout(() => void loadDevices(), 4000);
    }, "That decision couldn't be saved. Try again.");

  const saveEdit = () =>
    edit && run("edit", async () => {
      const payload: Record<string, unknown> = { device_id: edit.device.id };
      if (edit.name.trim() && edit.name.trim() !== edit.device.device_name) payload.device_name = edit.name.trim();
      if (edit.device.role === "child") payload.permissions = edit.permissions;
      if (Object.keys(payload).length > 1) await rpc("device_update", payload);
      setEdit(null);
      await loadDevices();
    }, "Changes couldn't be saved. Try again.");

  const setConnection = (device: HubDevice, connected: boolean) =>
    run(`conn:${device.id}`, async () => {
      await rpc("device_connection", { device_id: device.id, connected });
      await loadDevices();
    }, "The connection couldn't be changed. Try again.");

  const revoke = (device: HubDevice) =>
    run(`revoke:${device.id}`, async () => {
      await rpc("device_revoke", { device_id: device.id });
      if (device.id === currentId) {
        write(KEY.role, null); write(KEY.parent, null); write(KEY.child, null);
        setRole(null); setParentId(""); setChild(null); setPairing(null);
      }
      setConfirmRevoke(null);
      await loadDevices();
    }, "The device couldn't be removed. Try again.");

  function leaveRole() {
    write(KEY.role, null);
    setRole(null); setPairing(null); setError(""); setNotice("");
  }

  const parentDevice = devices?.find((device) => device.id === parentId);
  const shown = devices ?? [];

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold text-ink">This device</h2>
            <p className="text-xs text-ink-3">{me ? `${me.name}${me.os ? ` · ${me.os}` : ""}` : "\u00a0"}</p>
          </div>
          {role ? (
            <span className="flex items-center gap-2">
              <Badge className="!border-accent/40 !text-accent">{role === "parent" ? "Parent" : "Child"}</Badge>
              {role === "child" && child ? null : <Button variant="ghost" className="!min-h-8 !px-2 text-xs" onClick={leaveRole}>Change role</Button>}
            </span>
          ) : null}
        </div>

        <div aria-live="polite" className="space-y-2 empty:hidden">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
        </div>

        {!ready ? (
          <div className="h-28 animate-pulse rounded-xl bg-surface-2/60" aria-busy="true" aria-label="Loading device registration" />
        ) : role === null ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" onClick={() => void registerParent()} disabled={busy === "parent"} className="rounded-2xl border border-border bg-surface-2/50 p-4 text-left transition-colors hover:border-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60">
              <span className="flex items-center gap-2 font-semibold text-ink">
                {busy === "parent" ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} className="text-accent" />} Register as Parent
              </span>
              <span className="mt-1 block text-xs text-ink-2">Manage devices from here: show a pairing QR, approve requests, set permissions, and remove devices.</span>
            </button>
            <button type="button" onClick={() => { write(KEY.role, "child"); setRole("child"); setError(""); }} className="rounded-2xl border border-border bg-surface-2/50 p-4 text-left transition-colors hover:border-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <span className="flex items-center gap-2 font-semibold text-ink"><ScanLine size={16} className="text-accent" /> Register as Child</span>
              <span className="mt-1 block text-xs text-ink-2">Join by scanning the QR shown on a Parent device, then wait for the Parent to approve.</span>
            </button>
          </div>
        ) : role === "parent" ? (
          <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div className="space-y-3 rounded-2xl border border-border bg-surface-2/40 p-4 text-center">
              {pairing ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pairing.qr_data_url} alt="Pairing QR code for a Child device" className="mx-auto aspect-square w-full max-w-[15rem] rounded-xl bg-white p-2" />
                  <p className="flex items-center justify-center gap-1.5 text-xs text-ink-2" aria-live="off">
                    <Clock size={12} /> Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")} · single use
                  </p>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink-3">Or type this code</p>
                    <button type="button" className="mono mt-1 inline-flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-lg font-semibold tracking-widest text-ink" onClick={() => void navigator.clipboard.writeText(formatManualCode(pairing.manual_code)).then(() => toast("Code copied."), () => toast("Copy failed."))} aria-label={`Copy pairing code ${formatManualCode(pairing.manual_code)}`}>
                      {formatManualCode(pairing.manual_code)} <Copy size={14} className="text-ink-3" />
                    </button>
                  </div>
                  <Button variant="ghost" onClick={() => setPairing(null)}>Hide code</Button>
                </>
              ) : (
                <div className="flex aspect-square w-full max-w-[15rem] mx-auto flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border">
                  <QrCode size={28} className="text-ink-3" />
                  <Button onClick={() => void createQr()} disabled={busy === "qr" || !parentId}>
                    {busy === "qr" ? <Loader2 size={15} className="animate-spin" /> : <QrCode size={15} />} Show pairing QR
                  </Button>
                  <p className="px-3 text-[11px] text-ink-3">Valid for 5 minutes. Contains no password or key.</p>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-ink">Pairing requests</h3>
              {requests.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-4 text-sm text-ink-3">
                  {pairing ? "Waiting for a device to scan the code…" : "No requests waiting. Show the pairing QR, then scan it with the device you want to add."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {requests.map((request) => (
                    <li key={request.challenge_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/30 bg-surface-2/60 p-3">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="text-ink-3"><DeviceIcon device={request} /></span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{request.device_name}</span>
                          <span className="block text-[11px] text-ink-3">{[request.os || request.platform, request.device_type, `asked ${when(request.requested_at)}`].filter(Boolean).join(" · ")}</span>
                        </span>
                      </span>
                      <span className="flex gap-2">
                        <Button variant="outline" className="!min-h-8 !px-2.5 text-xs" disabled={busy.startsWith("decide")} onClick={() => void decide(request.challenge_id, false)}><X size={13} /> Decline</Button>
                        <Button className="!min-h-8 !px-2.5 text-xs" disabled={busy.startsWith("decide")} onClick={() => setApprove({ request, name: request.device_name, permissions: [...DEFAULT_CHILD_PERMISSIONS] })}><Check size={13} /> Review</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {parentDevice ? <p className="text-[11px] text-ink-3">Registered {when(parentDevice.registered_at)} as “{parentDevice.device_name}”.</p> : null}
            </div>
          </div>
        ) : child ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-2/40 p-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Users size={15} className="text-accent" /> {child.parent ? `Connected to ${child.parent.device_name}` : "Registered as a Child device"}
              </p>
              <p className="mt-0.5 text-xs text-ink-3">This device is “{child.device_name}”. The Parent controls its permissions and can remove it at any time.</p>
            </div>
            {childStatus === "unknown" ? <Badge>Checking…</Badge> : <Badge className={STATUS_TONE[childStatus]}>{STATUS_LABEL[childStatus]}</Badge>}
          </div>
        ) : pending ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface-2/40 p-6 text-center" role="status">
            <Loader2 size={22} className="animate-spin text-accent" />
            <p className="text-sm font-semibold text-ink">Waiting for the Parent to approve</p>
            <p className="max-w-sm text-xs text-ink-3">Open MATRIX on the Parent device and approve “{me?.name}”. This request expires at {new Date(pending.decide_by).toLocaleTimeString()}.</p>
            <Button variant="ghost" onClick={() => { write(KEY.pending, null); setPending(null); }}>Cancel</Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Scan the Parent&apos;s QR code</h3>
              <QrScanner onResult={onScan} paused={busy === "request"} />
            </div>
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submitRequest({ manual_code: manual }); }}>
              <h3 className="text-sm font-semibold text-ink">Or type the pairing code</h3>
              <Field label="Pairing code" htmlFor="hub-manual-code" hint="The 8-character code shown under the Parent's QR.">
                <Input id="hub-manual-code" value={manual} onChange={(event) => setManual(formatManualCode(event.target.value))} placeholder="ABCD-2345" autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text" className="mono tracking-widest" />
              </Field>
              <Button type="submit" disabled={busy === "request" || normalizeManualCode(manual).length !== 8}>
                {busy === "request" ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />} Request to join
              </Button>
              <p className="text-xs text-ink-3">Both devices must be signed in to the same MATRIX account. Nothing is shared until the Parent approves.</p>
            </form>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-ink">Registered devices</h2>
            <p className="text-xs text-ink-3">Status comes from each device&apos;s last check-in.</p>
          </div>
          <Badge>{devices ? shown.length : "…"}</Badge>
        </div>
        {devices === null ? (
          <div className="space-y-2" aria-busy="true"><div className="h-16 animate-pulse rounded-xl bg-surface-2/60" /><div className="h-16 animate-pulse rounded-xl bg-surface-2/60" /></div>
        ) : shown.length === 0 ? (
          <EmptyState icon={<Smartphone size={20} />} title="No devices registered yet" body="Register this device as a Parent, then add others by scanning its pairing QR." />
        ) : (
          <ul className="grid gap-2 lg:grid-cols-2">
            {shown.map((device) => {
              const manageable = role === "parent" || device.id === currentId;
              return (
                <li key={device.id} className="rounded-xl border border-border bg-surface-2/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2"><DeviceIcon device={device} /></span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">{device.device_name}{device.id === currentId ? <span className="text-ink-3"> · this device</span> : null}</span>
                        <span className="block truncate text-[11px] text-ink-3">{[device.role === "parent" ? "Parent" : "Child", device.device_type, device.os || device.platform, device.app_version ? `v${device.app_version}` : ""].filter(Boolean).join(" · ")}</span>
                      </span>
                    </span>
                    <Badge className={STATUS_TONE[device.status]}>{STATUS_LABEL[device.status]}</Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
                    <div><dt className="inline">Last active: </dt><dd className="inline text-ink-2">{when(device.last_active_at)}</dd></div>
                    <div><dt className="inline">Registered: </dt><dd className="inline text-ink-2">{device.registered_at ? new Date(device.registered_at).toLocaleDateString() : "—"}</dd></div>
                    <div className="col-span-2"><dt className="inline">Can do: </dt><dd className="inline text-ink-2">{deviceCapabilities(device).join(", ")}</dd></div>
                    {device.role === "child" ? (
                      <div className="col-span-2"><dt className="inline">Permissions: </dt><dd className="inline text-ink-2">{device.permissions.length ? device.permissions.map((p) => PERMISSION_INFO[p].label).join(", ") : "None"}</dd></div>
                    ) : null}
                  </dl>
                  {manageable ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {role === "parent" ? (
                        <Button variant="ghost" className="!min-h-8 !px-2 text-xs" onClick={() => setEdit({ device, name: device.device_name, permissions: device.permissions })}><Pencil size={13} /> {device.role === "child" ? "Rename & permissions" : "Rename"}</Button>
                      ) : null}
                      {role === "parent" && device.role === "child" ? (
                        device.status === "disconnected" ? (
                          <Button variant="ghost" className="!min-h-8 !px-2 text-xs" disabled={busy === `conn:${device.id}`} onClick={() => void setConnection(device, true)}><Plug size={13} /> Reconnect</Button>
                        ) : (
                          <Button variant="ghost" className="!min-h-8 !px-2 text-xs" disabled={busy === `conn:${device.id}`} onClick={() => void setConnection(device, false)}><Unplug size={13} /> Disconnect</Button>
                        )
                      ) : null}
                      <Button variant="ghost" className="!min-h-8 !px-2 text-xs text-danger" onClick={() => setConfirmRevoke(device)}><Trash2 size={13} /> Remove</Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {role !== "parent" && shown.length > 0 ? <p className="text-[11px] text-ink-3">Renaming, permissions and disconnecting are available on a Parent device.</p> : null}
      </Card>

      <Modal open={Boolean(approve)} onClose={() => setApprove(null)} title="Approve this device?" description="Only approve a device you are holding and recognise." size="sm"
        footer={approve ? (
          <>
            <Button variant="outline" disabled={busy.startsWith("decide")} onClick={() => void decide(approve.request.challenge_id, false)}>Decline</Button>
            <Button disabled={busy.startsWith("decide") || !approve.name.trim()} onClick={() => void decide(approve.request.challenge_id, true, { permissions: approve.permissions, device_name: approve.name.trim() })}>
              {busy.startsWith("decide") ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Approve
            </Button>
          </>
        ) : null}>
        {approve ? (
          <div className="space-y-3">
            <p className="text-xs text-ink-3">{[approve.request.os || approve.request.platform, approve.request.device_type, approve.request.app_version ? `app v${approve.request.app_version}` : ""].filter(Boolean).join(" · ")}</p>
            <Field label="Device name" htmlFor="hub-approve-name"><Input id="hub-approve-name" value={approve.name} maxLength={80} onChange={(event) => setApprove({ ...approve, name: event.target.value })} /></Field>
            <div><p className="mb-1.5 text-sm font-medium text-ink">Permissions</p><PermissionList value={approve.permissions} onChange={(permissions) => setApprove({ ...approve, permissions })} /></div>
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title="Device settings" size="sm"
        footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={busy === "edit" || !edit?.name.trim()} onClick={() => void saveEdit()}>{busy === "edit" ? <Loader2 size={15} className="animate-spin" /> : null} Save</Button></>}>
        {edit ? (
          <div className="space-y-3">
            <Field label="Device name" htmlFor="hub-edit-name"><Input id="hub-edit-name" value={edit.name} maxLength={80} onChange={(event) => setEdit({ ...edit, name: event.target.value })} /></Field>
            {edit.device.role === "child" ? (
              <div><p className="mb-1.5 text-sm font-medium text-ink">Permissions</p><PermissionList value={edit.permissions} onChange={(permissions) => setEdit({ ...edit, permissions })} /><p className="mt-1.5 text-xs text-ink-3">Changes apply to the device&apos;s next request.</p></div>
            ) : <p className="text-xs text-ink-3">A Parent device uses your account sign-in, so it always has full access.</p>}
          </div>
        ) : null}
      </Modal>

      <ConfirmModal
        open={Boolean(confirmRevoke)}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => { if (confirmRevoke) void revoke(confirmRevoke); }}
        title="Remove this device?"
        body={confirmRevoke ? `“${confirmRevoke.device_name}” will lose access immediately. To use it again it must be registered and approved again.` : ""}
        confirmLabel="Remove device"
      />
    </div>
  );
}
