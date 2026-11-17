"use client";

// =============================================================================
// Cross-Device Notification Ecosystem & Parent Policy Center
// Aligned 1:1 with server contracts in notifications-sync.ts & parent-policy.ts
// =============================================================================

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  BellOff, Check, CheckCheck, EyeOff, Lock, Plus, RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Trash2, UserCheck, X,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input } from "@/components/ui";
import { ConfirmModal } from "@/components/modal";
import { rpc, RpcCallError } from "@/lib/client/api";
import type { HubDevice } from "@/lib/devices/model";

type SyncedNotif = {
  id: string;
  source_device_id: string;
  source_device_name: string;
  source_platform: string;
  package_name: string;
  app_name: string;
  title: string;
  body: string;
  privacy_mode: string;
  is_protected: boolean;
  read_at: string | null;
  dismissed_at: string | null;
  posted_at: string;
  synced_at: string;
};

type SyncPrefs = {
  user_id: string;
  sync_enabled: boolean;
  privacy_mode: "full" | "title_only" | "app_only" | "paused";
  redact_otp: boolean;
  excluded_apps: string[];
  allowed_target_device_ids: string[];
};

type ParentLinkRow = {
  link_id: string;
  child_uid: string;
  child_email_masked: string;
  parent_uid: string | null;
  parent_email_masked: string;
  relationship_label: string;
  status: string;
  created_at: string;
  verified_at: string;
};

type PolicyRule = {
  enabled: boolean;
  require_parent_approval: boolean;
  cooldown_minutes: number;
};

type PolicyEventKey =
  | "notification_access_enabled"
  | "protected_notification_dismissed"
  | "policy_disabled"
  | "device_unpaired"
  | "critical_permission_revoked";

type ParentPolicyConfig = {
  user_id: string;
  rules: Record<PolicyEventKey, PolicyRule>;
  updated_at: string;
};

type ProtectedActionRow = {
  request_id: string;
  user_id: string;
  parent_uid: string;
  event_type: string;
  action_type: string;
  target_id: string;
  summary: string;
  status: string;
  execution_status: string;
  created_at: string;
  decided_at: string;
};

type ParentDashboard = {
  my_parent_links: ParentLinkRow[];
  children_i_supervise: ParentLinkRow[];
  policy: ParentPolicyConfig;
  actions: ProtectedActionRow[];
  env_parent_email_configured: boolean;
};

const POLICY_LABELS: Record<PolicyEventKey, string> = {
  notification_access_enabled: "Notification access enabled",
  protected_notification_dismissed: "Protected notification dismissed",
  policy_disabled: "Parent policy changed / removed",
  device_unpaired: "Device unpaired / revoked",
  critical_permission_revoked: "Critical permission removed",
};

type TabId = "feed" | "preferences" | "parent_safety";

export function NotificationsCenter({ initialVerifyToken = "" }: { initialVerifyToken?: string }) {
  const [tab, setTab] = useState<TabId>(initialVerifyToken ? "parent_safety" : "feed");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [notifications, setNotifications] = useState<SyncedNotif[]>([]);
  const [prefs, setPrefs] = useState<SyncPrefs | null>(null);
  const [devices, setDevices] = useState<HubDevice[]>([]);
  const [parentDash, setParentDash] = useState<ParentDashboard | null>(null);

  const [newExcludedApp, setNewExcludedApp] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [relationshipLabel, setRelationshipLabel] = useState("Parent / Guardian");
  const [verifyTokenInput, setVerifyTokenInput] = useState(initialVerifyToken);
  const [confirmClear, setConfirmClear] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listRes, prefsRes, devicesRes, parentRes] = await Promise.all([
        rpc<{ items: SyncedNotif[]; preferences: SyncPrefs }>("notifications_sync_list", { include_dismissed: false, limit: 100 }),
        rpc<SyncPrefs>("notifications_sync_prefs_get"),
        rpc<HubDevice[]>("device_list").catch(() => [] as HubDevice[]),
        rpc<ParentDashboard>("parent_policy_dashboard").catch(() => null),
      ]);
      setNotifications(listRes.items ?? []);
      setPrefs(prefsRes ?? listRes.preferences);
      setDevices(devicesRes ?? []);
      setParentDash(parentRes);
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not load notification ecosystem.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function savePrefs(patch: Partial<SyncPrefs>) {
    if (!prefs) return;
    setBusy("prefs");
    setError("");
    setNotice("");
    try {
      const res = await rpc<{ preferences: SyncPrefs; policy_status?: string }>("notifications_sync_prefs_update", patch);
      setPrefs(res.preferences);
      setNotice(
        res.policy_status === "notified"
          ? "Notification sync updated (verified parent notified)."
          : "Notification sync settings updated.",
      );
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not update preferences.");
    } finally {
      setBusy("");
    }
  }

  async function markAllRead() {
    setBusy("read_all");
    try {
      await rpc("notifications_sync_mark_read", { all: true });
      await loadAll();
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Failed to mark read.");
    } finally {
      setBusy("");
    }
  }

  async function dismissOne(id: string) {
    setBusy(`dismiss:${id}`);
    setError("");
    setNotice("");
    try {
      const res = await rpc<{ status: string; command_queued?: boolean; request_id?: string }>(
        "notifications_sync_dismiss",
        { id },
      );
      if (res.status === "pending_approval") {
        setNotice("Protected notification dismissal requires verified parent approval (request sent).");
      } else {
        setNotifications((list) => list.filter((n) => n.id !== id));
        setNotice(res.command_queued ? "Notification dismissed and Android dismissal queued." : "Notification dismissed.");
      }
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Failed to dismiss notification.");
    } finally {
      setBusy("");
    }
  }

  async function clearHistory() {
    setBusy("clear");
    setError("");
    try {
      const res = await rpc<{ cleared: number; held_protected: number }>("notifications_sync_clear");
      setConfirmClear(false);
      await loadAll();
      setNotice(
        `Cleared ${res.cleared} notification(s)${res.held_protected ? ` (${res.held_protected} protected item(s) kept)` : ""}.`,
      );
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not clear history.");
    } finally {
      setBusy("");
    }
  }

  async function sendParentInvite(e: FormEvent) {
    e.preventDefault();
    if (!parentEmail.trim()) return;
    setBusy("parent_invite");
    setError("");
    setNotice("");
    try {
      const res = await rpc<{
        link_id: string;
        email_status: string;
        email_reason?: string;
        sender_used?: string;
      }>("parent_link_request", {
        parent_email: parentEmail.trim(),
        relationship_label: relationshipLabel.trim() || "Parent / Guardian",
      });
      setParentEmail("");
      setNotice(
        res.email_status === "accepted_by_provider"
          ? `Verification link sent to parent email via ${res.sender_used ?? "Resend"}.`
          : `Parent link created (status: ${res.email_status}${res.email_reason ? ` — ${res.email_reason}` : ""}).`,
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not request parent verification.");
    } finally {
      setBusy("");
    }
  }

  async function verifyParentToken(e: FormEvent) {
    e.preventDefault();
    const tok = verifyTokenInput.trim();
    if (!tok) return;
    setBusy("verify_token");
    setError("");
    setNotice("");
    try {
      await rpc("parent_link_verify", { token: tok });
      setVerifyTokenInput("");
      setNotice("Parent verification confirmed! You are now a verified parent contact.");
      await loadAll();
    } catch (err) {
      setError(
        err instanceof RpcCallError
          ? err.code === "PARENT_EMAIL_MISMATCH"
            ? "Sign in with the exact verified parent email address invited in this link."
            : err.code
          : "Verification failed.",
      );
    } finally {
      setBusy("");
    }
  }

  async function revokeLink(linkId: string) {
    setBusy(`revoke_link:${linkId}`);
    setError("");
    try {
      const res = await rpc<{ status: string }>("parent_link_revoke", { link_id: linkId });
      setNotice(
        res.status === "pending_approval"
          ? "Removing a verified parent link requires parent approval (request sent)."
          : "Parent link revoked.",
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not revoke link.");
    } finally {
      setBusy("");
    }
  }

  async function updatePolicyRule(eventKey: PolicyEventKey, patch: Partial<PolicyRule>) {
    if (!parentDash) return;
    setBusy("policy");
    setError("");
    setNotice("");
    try {
      const nextRules = {
        ...parentDash.policy.rules,
        [eventKey]: {
          ...parentDash.policy.rules[eventKey],
          ...patch,
        },
      };
      const res = await rpc<{ status: string }>("parent_policy_update", {
        rules: nextRules,
      });
      setNotice(
        res.status === "pending_approval"
          ? "Relaxing this protected policy requires parent approval (request queued)."
          : "Parent safety policy updated.",
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Could not update policy.");
    } finally {
      setBusy("");
    }
  }

  async function decideApproval(requestId: string, approve: boolean) {
    setBusy(`decide:${requestId}`);
    setError("");
    try {
      await rpc("protected_action_decide", { request_id: requestId, approve });
      setNotice(approve ? "Protected action approved and executed." : "Protected action denied.");
      await loadAll();
    } catch (err) {
      setError(err instanceof RpcCallError ? err.code : "Decision failed.");
    } finally {
      setBusy("");
    }
  }

  const unreadCount = notifications.filter((n) => !n.read_at).length;
  const pendingParentApprovals = (parentDash?.actions ?? []).filter(
    (a) => a.status === "pending_approval" && !parentDash?.my_parent_links.some((l) => l.parent_uid === a.parent_uid && l.child_uid === a.user_id && l.child_uid === parentDash.policy.user_id),
  );
  // Approvals actionable by the signed-in user as a verified parent:
  const actionableAsParent = (parentDash?.actions ?? []).filter(
    (a) => a.status === "pending_approval" && a.parent_uid !== a.user_id && a.user_id !== parentDash?.policy.user_id,
  );

  return (
    <div className="space-y-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1">
          <button
            type="button"
            onClick={() => setTab("feed")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === "feed" ? "bg-accent-solid text-accent-ink" : "text-ink-2 hover:text-ink"}`}
          >
            Synced feed {unreadCount > 0 ? `(${unreadCount})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setTab("preferences")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === "preferences" ? "bg-accent-solid text-accent-ink" : "text-ink-2 hover:text-ink"}`}
          >
            Sync &amp; Privacy
          </button>
          <button
            type="button"
            onClick={() => setTab("parent_safety")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === "parent_safety" ? "bg-accent-solid text-accent-ink" : "text-ink-2 hover:text-ink"}`}
          >
            Parent Safety {pendingParentApprovals.length > 0 ? `(${pendingParentApprovals.length})` : ""}
          </button>
        </div>

        <Button variant="secondary" className="!min-h-8 !px-3 !text-xs" disabled={loading} onClick={() => void loadAll()}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>

      {tab === "feed" ? (
        <Card className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-ink">Cross-Device Synced Notifications</h2>
              <p className="text-xs text-ink-3">
                Opt-in notifications mirrored from your paired Android phone / Desktop devices. Retained up to 7 days.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {unreadCount > 0 ? (
                <Button variant="secondary" className="!min-h-8 !px-3 !text-xs" disabled={busy !== ""} onClick={() => void markAllRead()}>
                  <CheckCheck size={14} /> Mark all read
                </Button>
              ) : null}
              {notifications.length > 0 ? (
                <Button variant="ghost" className="!min-h-8 !px-3 !text-xs text-danger" disabled={busy !== ""} onClick={() => setConfirmClear(true)}>
                  <Trash2 size={14} /> Clear history
                </Button>
              ) : null}
            </div>
          </div>

          {loading && notifications.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-3">Loading synced notifications…</p>
          ) : notifications.length === 0 ? (
            <EmptyState
              icon={<BellOff size={20} />}
              title="No synced notifications"
              body="Enable Notification Sync below and allow Android Notification Access to mirror alerts across your paired devices."
            />
          ) : (
            <ul className="space-y-2">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`rounded-xl border p-3 transition ${
                    n.read_at ? "border-border bg-surface-2/40" : "border-accent/35 bg-accent-soft/15"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>{n.app_name}</Badge>
                        <span className="text-xs text-ink-3">
                          <Smartphone size={11} className="mr-1 inline" />
                          {n.source_device_name || n.source_platform}
                        </span>
                        {n.is_protected ? (
                          <Badge className="!border-warning/40 !text-warning">
                            <Lock size={11} /> Protected
                          </Badge>
                        ) : null}
                        {n.privacy_mode !== "full" ? (
                          <Badge>
                            <EyeOff size={11} /> {n.privacy_mode}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm font-medium text-ink">{n.title}</p>
                      {n.body ? <p className="text-xs text-ink-2">{n.body}</p> : null}
                      <p className="text-[11px] text-ink-3">{new Date(n.synced_at || n.posted_at).toLocaleString()}</p>
                    </div>
                    <Button
                      variant="ghost"
                      className="!min-h-8 !px-2.5 !text-xs"
                      disabled={busy === `dismiss:${n.id}`}
                      onClick={() => void dismissOne(n.id)}
                      title="Dismiss across synced devices"
                    >
                      <X size={14} /> Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === "preferences" && prefs ? (
        <div className="space-y-4">
          <Card className="space-y-4">
            <h2 className="font-semibold text-ink">Sync &amp; Privacy Controls</h2>

            <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/40 p-3">
              <div>
                <p className="text-sm font-medium text-ink">Enable cross-device notification sync</p>
                <p className="text-xs text-ink-3">Allows paired devices with the sync permission to mirror alerts to your account.</p>
              </div>
              <input
                type="checkbox"
                checked={prefs.sync_enabled}
                disabled={busy === "prefs"}
                onChange={(e) => void savePrefs({ sync_enabled: e.target.checked })}
                className="h-4 w-4 accent-accent"
              />
            </label>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-ink-2">Content privacy mode</label>
              <select
                value={prefs.privacy_mode}
                disabled={busy === "prefs"}
                onChange={(e) => void savePrefs({ privacy_mode: e.target.value as SyncPrefs["privacy_mode"] })}
                className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="full">Full (App + Title + Message snippet)</option>
                <option value="title_only">Title only (Hide message body)</option>
                <option value="app_only">App name only (Hide title and body)</option>
                <option value="paused">Paused (Drop incoming syncs)</option>
              </select>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/40 p-3">
              <div>
                <p className="text-sm font-medium text-ink">Automatically mask OTP / verification codes</p>
                <p className="text-xs text-ink-3">Replaces numeric passcodes in synced messages with [CODE].</p>
              </div>
              <input
                type="checkbox"
                checked={prefs.redact_otp}
                disabled={busy === "prefs"}
                onChange={(e) => void savePrefs({ redact_otp: e.target.checked })}
                className="h-4 w-4 accent-accent"
              />
            </label>
          </Card>

          <Card className="space-y-3">
            <h3 className="font-semibold text-ink">Excluded Apps (Never Synced or Stored)</h3>
            <p className="text-xs text-ink-3">Banking apps, authenticators, or private packages listed here are dropped BEFORE storage.</p>
            <div className="flex gap-2">
              <Input
                value={newExcludedApp}
                onChange={(e) => setNewExcludedApp(e.target.value)}
                placeholder="Package or app name (e.g. com.android.bank or WhatsApp)"
              />
              <Button
                type="button"
                disabled={!newExcludedApp.trim() || busy === "prefs"}
                onClick={() => {
                  const val = newExcludedApp.trim();
                  if (!val) return;
                  const next = Array.from(new Set([...prefs.excluded_apps, val]));
                  setNewExcludedApp("");
                  void savePrefs({ excluded_apps: next });
                }}
              >
                <Plus size={14} /> Add
              </Button>
            </div>
            {prefs.excluded_apps.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {prefs.excluded_apps.map((pkg) => (
                  <span key={pkg} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs">
                    {pkg}
                    <button
                      type="button"
                      className="text-ink-3 hover:text-danger"
                      onClick={() => void savePrefs({ excluded_apps: prefs.excluded_apps.filter((x) => x !== pkg) })}
                      aria-label={`Remove ${pkg}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink-3">No excluded apps configured.</p>
            )}
          </Card>

          <Card className="space-y-3">
            <h3 className="font-semibold text-ink">Target Device Isolation</h3>
            <p className="text-xs text-ink-3">
              Optionally restrict synced notifications to selected paired devices. Leave all unchecked to mirror to all active devices on your account.
            </p>
            {devices.length === 0 ? (
              <p className="text-xs text-ink-3">No paired devices found.</p>
            ) : (
              <ul className="space-y-1.5">
                {devices.map((d) => {
                  const checked = prefs.allowed_target_device_ids.includes(d.id);
                  return (
                    <li key={d.id}>
                      <label className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/40 px-3 py-2 text-sm">
                        <span>
                          {d.device_name} <span className="text-xs text-ink-3">({d.platform})</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy === "prefs"}
                          onChange={() => {
                            const next = checked
                              ? prefs.allowed_target_device_ids.filter((id) => id !== d.id)
                              : [...prefs.allowed_target_device_ids, d.id];
                            void savePrefs({ allowed_target_device_ids: next });
                          }}
                          className="h-4 w-4 accent-accent"
                        />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "parent_safety" ? (
        <div className="space-y-4">
          <Card className="space-y-4">
            <div className="flex items-start gap-2.5">
              <UserCheck size={18} className="mt-0.5 shrink-0 text-accent" />
              <div>
                <h2 className="font-semibold text-ink">Verified Parent Safety Links</h2>
                <p className="text-xs text-ink-3">
                  A parent receives alerts ONLY after opening their single-use verification link while signed in with their verified email address. Email links never auto-approve sensitive actions.
                </p>
              </div>
            </div>

            <form onSubmit={sendParentInvite} className="grid gap-3 sm:grid-cols-3">
              <Field label="Parent email" htmlFor="parent-link-email">
                <Input
                  id="parent-link-email"
                  type="email"
                  required
                  value={parentEmail}
                  onChange={(e) => setParentEmail(e.target.value)}
                  placeholder="parent@example.com"
                />
              </Field>
              <Field label="Relationship" htmlFor="parent-link-rel">
                <Input
                  id="parent-link-rel"
                  value={relationshipLabel}
                  onChange={(e) => setRelationshipLabel(e.target.value)}
                  placeholder="Parent / Guardian"
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={busy === "parent_invite"} className="w-full">
                  Send verification link
                </Button>
              </div>
            </form>

            {parentDash?.my_parent_links?.length ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-ink-2">Your linked parent contacts</p>
                {parentDash.my_parent_links.map((l) => (
                  <div key={l.link_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/40 p-2.5 text-xs">
                    <div>
                      <span className="font-medium text-ink">{l.parent_email_masked}</span> ({l.relationship_label}) ·{" "}
                      <Badge className={l.status === "verified" ? "!border-success/40 !text-success" : "!border-warning/40 !text-warning"}>
                        {l.status}
                      </Badge>
                    </div>
                    <Button variant="ghost" className="!min-h-8 !px-2.5 !text-xs text-danger" onClick={() => void revokeLink(l.link_id)}>
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>

          <Card className="space-y-3">
            <h3 className="font-semibold text-ink">Verify a Parent Invitation Token</h3>
            <p className="text-xs text-ink-3">If you are a parent verifying your child&apos;s link, paste the token from your email or open the verification link directly while signed in.</p>
            <form onSubmit={verifyParentToken} className="flex gap-2">
              <Input
                value={verifyTokenInput}
                onChange={(e) => setVerifyTokenInput(e.target.value)}
                placeholder="Verification token"
              />
              <Button type="submit" disabled={!verifyTokenInput.trim() || busy === "verify_token"}>
                Verify link
              </Button>
            </form>
          </Card>

          {parentDash?.policy ? (
            <Card className="space-y-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={17} className="text-accent" />
                <h3 className="font-semibold text-ink">Parent Alert &amp; Protection Policy Rules</h3>
              </div>
              <div className="space-y-2">
                {(Object.keys(POLICY_LABELS) as PolicyEventKey[]).map((evKey) => {
                  const rule = parentDash.policy.rules[evKey];
                  if (!rule) return null;
                  return (
                    <div key={evKey} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/40 p-3 text-xs">
                      <div>
                        <p className="font-medium text-ink">{POLICY_LABELS[evKey]}</p>
                        <p className="text-ink-3">Cooldown: {rule.cooldown_minutes} min</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            disabled={busy === "policy"}
                            onChange={(e) => void updatePolicyRule(evKey, { enabled: e.target.checked })}
                            className="h-4 w-4 accent-accent"
                          />
                          <span>Notify parent</span>
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={rule.require_parent_approval}
                            disabled={busy === "policy"}
                            onChange={(e) => void updatePolicyRule(evKey, { require_parent_approval: e.target.checked })}
                            className="h-4 w-4 accent-accent"
                          />
                          <span>Require approval</span>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}

          {actionableAsParent.length > 0 ? (
            <Card className="space-y-3 border-warning/40">
              <div className="flex items-center gap-2 text-warning">
                <ShieldAlert size={18} />
                <h3 className="font-semibold text-ink">Pending Protected Action Approvals</h3>
              </div>
              <ul className="space-y-2">
                {actionableAsParent.map((req) => (
                  <li key={req.request_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/40 p-3 text-xs">
                    <div>
                      <p className="font-medium text-ink">{req.summary}</p>
                      <p className="text-ink-3">Action: {req.action_type} · Requested {new Date(req.created_at).toLocaleString()}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" className="!min-h-8 !px-3 !text-xs" disabled={busy === `decide:${req.request_id}`} onClick={() => void decideApproval(req.request_id, false)}>
                        <X size={13} /> Deny
                      </Button>
                      <Button className="!min-h-8 !px-3 !text-xs" disabled={busy === `decide:${req.request_id}`} onClick={() => void decideApproval(req.request_id, true)}>
                        <Check size={13} /> Approve
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      <ConfirmModal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void clearHistory()}
        title="Clear notification history?"
        body="This deletes unprotected synced notifications stored on QORVYNA."
        confirmLabel="Clear history"
        busy={busy === "clear"}
      />
    </div>
  );
}
