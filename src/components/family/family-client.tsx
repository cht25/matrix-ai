"use client";

// MATRIX Family — clear household identity, cross-account member devices,
// resendable Resend invitations + QR popups, Google Family Link–style remote
// lock, transparent live screen-mirror (ss) viewer, and full opt-in child
// telemetry (screen time, app usage, hidden apps, browser history).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Camera, Check, Clock, Copy, Crown, Edit3, Eye, EyeOff, Globe, HelpCircle,
  Link2, Loader2, Lock, Mail, Monitor, Plus, QrCode, RefreshCw, Send, ShieldAlert,
  ShieldCheck, Smartphone, StopCircle, Trash2, Unlock, UserPlus, Users, Wifi, WifiOff,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input } from "@/components/ui";
import { Modal, ConfirmModal } from "@/components/modal";
import { UserAvatar } from "@/components/avatar";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError, uploadOwnedFile } from "@/lib/client/api";
import { notifyWorkDone } from "@/lib/client/work-notifications";
import {
  CHILD_DEVICE_FEATURES,
  FEATURE_DESCRIPTION,
  FEATURE_LABEL,
  type ChildDeviceFeature,
  type FamilyListRow,
  type FamilyMemberSummary,
  type FamilyOverview,
  type MirrorState,
} from "@/lib/family";
import { cn } from "@/lib/utils";

type InviteResult = {
  invitation_id: string;
  token: string;
  invite_url: string;
  expires_at: string;
  email_status: string;
  email_reason?: string;
  resend_count?: number;
  qr_data_url: string;
};

type FamilyPairingGrant = {
  qr_payload: string;
  pair_url?: string;
  qr_data_url: string;
  expires_at: string;
  member_id: string;
  member_name: string;
};

type MirrorSessionView = {
  session_id: string;
  status: "active" | "ended";
  started_at: string;
  expires_at: string;
  ended_reason: string | null;
  frames: number;
  latest_frame_at: string;
  frame_data_url: string | null;
};

const MIRROR_COPY: Record<MirrorState, { label: string; tone: string; body: string }> = {
  never: {
    label: "Not set up",
    tone: "text-ink-3",
    body: "Both a parent grant and the member's on-device consent are required before screen mirroring can start.",
  },
  granted: {
    label: "Ready (consented)",
    tone: "text-success",
    body: "Screen mirroring is permitted. Starting a session immediately notifies and shows a live banner on the member's device.",
  },
  revoked_by_child: {
    label: "Disabled by member",
    tone: "text-warning",
    body: "The member disabled mirroring on their device. A parent must click Grant mirroring AND the member must allow it again.",
  },
  denied_by_parent: {
    label: "Turned off by parent",
    tone: "text-ink-3",
    body: "Screen mirroring is disabled in supervision settings for this member.",
  },
  expired: {
    label: "Grant expired",
    tone: "text-ink-3",
    body: "The previous mirroring grant expired and needs to be renewed.",
  },
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof RpcCallError) {
    const map: Record<string, string> = {
      NOT_A_MEMBER: "You are not an active member of this family.",
      PERMISSION_DENIED: "Your family role does not allow that action.",
      PRIMARY_PARENT_REQUIRED: "Only the primary parent can perform this action.",
      PRIMARY_PARENT_IMMUTABLE: "The primary parent cannot be removed or demoted. Transfer primary parent first.",
      MIRROR_CONSENT_REQUIRED: "Both parent grant and member consent on their device are required before viewing.",
      MIRROR_REVOKED_BY_CHILD: "The member disabled mirroring. Click “Grant mirroring” first, then have the member re-enable it on their device.",
      MIRROR_FEATURE_DISABLED: "Enable “Screen mirroring” in Supervision checkboxes first.",
      DEVICE_LOCK_FEATURE_DISABLED: "Enable “Remote device lock” in Supervision checkboxes first.",
      ALREADY_MEMBER: "That email already belongs to an active member of this family.",
      EMAIL_INVALID: "Enter a valid email address.",
      INVITATION_EMAIL_MISMATCH: "Sign in with the exact email address that received this invitation.",
      INVITATION_EXPIRED: "That invitation has expired. Ask a parent to click Resend.",
      INVITATION_ALREADY_USED: "That invitation link was already used.",
      INVITATION_RESEND_LIMIT: "This invitation reached its resend limit. Create a fresh invitation.",
      CONSENT_CHILD_ONLY: "Supervision controls only apply to child members.",
      FEATURE_INVALID: "One of the selected supervision features is invalid.",
    };
    return map[err.code] ?? err.code.replace(/_/g, " ").toLowerCase();
  }
  return fallback;
}

function expiresIn(iso: string): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
  if (hours >= 1) return `${hours}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

function relative(iso: string): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function FamilyClient() {
  const toast = useToast();
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const [families, setFamilies] = useState<FamilyListRow[]>([]);
  const [activeId, setActiveId] = useState("");
  const [overview, setOverview] = useState<FamilyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // Modals & editors
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

  const [pairGrant, setPairGrant] = useState<FamilyPairingGrant | null>(null);
  const [pairModalOpen, setPairModalOpen] = useState(false);

  const [detailMember, setDetailMember] = useState<string | null>(null);
  const [activityTab, setActivityTab] = useState<"apps" | "hidden" | "history">("apps");
  const [lockReason, setLockReason] = useState("");

  const [mirrorSession, setMirrorSession] = useState<MirrorSessionView | null>(null);
  const [mirrorTargetName, setMirrorTargetName] = useState("");
  const [mirrorModalOpen, setMirrorModalOpen] = useState(false);

  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void>; label: string } | null>(null);
  const [joinToken, setJoinToken] = useState("");
  const [joinReview, setJoinReview] = useState<{ name: string; role: string; expires_at: string; invited_by_name: string } | null>(null);

  const loadFamilies = useCallback(async () => {
    try {
      const list = await rpc<FamilyListRow[]>("family_list");
      setFamilies(list);
      setActiveId((current) => (current && list.some((row) => row.family_id === current) ? current : list[0]?.family_id ?? ""));
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load your families."));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOverview = useCallback(async (familyId: string) => {
    if (!familyId) {
      setOverview(null);
      return;
    }
    try {
      setOverview(await rpc<FamilyOverview>("family_overview", { family_id: familyId }));
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load this family."));
    }
  }, []);

  useEffect(() => {
    void loadFamilies();
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("invite");
    if (token) {
      setJoinToken(token);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      void rpc<{ name: string; role: string; expires_at: string; invited_by_name: string }>("family_invitation_review", { token })
        .then((res) => setJoinReview(res))
        .catch(() => {});
    }
    const refresh = () => {
      if (!document.hidden) void loadFamilies();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadFamilies]);

  useEffect(() => {
    void loadOverview(activeId);
  }, [activeId, loadOverview]);

  // Poll live mirror viewer while modal is open
  useEffect(() => {
    if (!mirrorModalOpen || !mirrorSession?.session_id) return;
    const sid = mirrorSession.session_id;
    const poll = async () => {
      try {
        const next = await rpc<MirrorSessionView>("family_mirror_status", { session_id: sid });
        setMirrorSession(next);
      } catch {
        // Keep last state visible
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => window.clearInterval(timer);
  }, [mirrorModalOpen, mirrorSession?.session_id]);

  const me = overview?.me;
  const isParent = me?.role === "parent";
  const isPrimary = me?.is_primary === true;

  const members = overview?.members ?? [];
  const meSummary = useMemo(() => members.find((m) => m.is_me) ?? null, [members]);
  const pendingInvites = useMemo(
    () => (overview?.invitations ?? []).filter((row) => row.status === "pending"),
    [overview],
  );
  const detail = useMemo(
    () => members.find((member) => member.member_id === detailMember) ?? null,
    [detailMember, members],
  );

  async function act(key: string, run: () => Promise<unknown>, success: string) {
    setBusy(key);
    setError("");
    try {
      await run();
      await Promise.all([loadFamilies(), activeId ? loadOverview(activeId) : Promise.resolve()]);
      toast(success);
      return true;
    } catch (err) {
      setError(errorMessage(err, "That action did not complete."));
      return false;
    } finally {
      setBusy("");
    }
  }

  async function createFamily() {
    const name = newName.trim();
    if (name.length < 2) return;
    setBusy("create");
    try {
      const created = await rpc<{ family_id: string }>("family_create", { name });
      setNewName("");
      setCreateOpen(false);
      await loadFamilies();
      setActiveId(created.family_id);
      toast("Family created. You are the primary parent.");
    } catch (err) {
      setError(errorMessage(err, "Could not create the family."));
    } finally {
      setBusy("");
    }
  }

  async function saveFamilyName() {
    if (!activeId || renameValue.trim().length < 2) return;
    const ok = await act(
      "rename",
      () => rpc("family_rename", { family_id: activeId, name: renameValue.trim() }),
      "Family name updated.",
    );
    if (ok) setRenameOpen(false);
  }

  async function saveMyDisplayName() {
    if (!profileName.trim()) return;
    const ok = await act(
      "profile-name",
      () => rpc("profile_update", { full_name: profileName.trim() }),
      "Your family display name was updated.",
    );
    if (ok) setProfileOpen(false);
  }

  async function handleAvatarUpload(file: File | undefined | null) {
    if (!file) return;
    if (avatarInputRef.current) avatarInputRef.current.value = "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast("Choose a PNG, JPEG, or WebP photo.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast("Photo must be 5 MB or smaller.");
      return;
    }
    setBusy("avatar");
    try {
      const avatarUrl = await uploadOwnedFile("avatars", file);
      await rpc("profile_update", { avatar_url: avatarUrl });
      await loadOverview(activeId);
      toast("Profile photo updated.");
    } catch (err) {
      setError(errorMessage(err, "Could not upload profile photo."));
    } finally {
      setBusy("");
    }
  }

  async function sendInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setBusy("invite");
    try {
      const result = await rpc<InviteResult>("family_invite", { family_id: activeId, invitee_email: email });
      setInvite(result);
      setInviteEmail("");
      setInviteOpen(false);
      setQrOpen(true);
      await loadOverview(activeId);
      toast(
        result.email_status === "accepted_by_provider"
          ? "Invitation emailed via Resend. QR and direct link are ready too."
          : "Invitation created. Share the QR code or direct link below.",
      );
    } catch (err) {
      setError(errorMessage(err, "Could not create the invitation."));
    } finally {
      setBusy("");
    }
  }

  async function resendInvitation(invitationId: string) {
    setBusy(`resend-${invitationId}`);
    try {
      const result = await rpc<InviteResult>("family_invitation_resend", { invitation_id: invitationId });
      setInvite(result);
      setQrOpen(true);
      await loadOverview(activeId);
      toast(
        result.email_status === "accepted_by_provider"
          ? "Fresh invitation emailed via Resend. Previous link was invalidated."
          : "Fresh invitation link & QR generated.",
      );
    } catch (err) {
      setError(errorMessage(err, "Could not resend the invitation."));
    } finally {
      setBusy("");
    }
  }

  async function openDeviceLinkQr(member: FamilyMemberSummary) {
    setBusy(`pair-${member.member_id}`);
    try {
      const grant = await rpc<FamilyPairingGrant>("family_pairing_create", {
        family_id: activeId,
        member_id: member.member_id,
        device_label: `${member.display_name || "Member"}'s device`,
      });
      setPairGrant(grant);
      setPairModalOpen(true);
    } catch (err) {
      setError(errorMessage(err, "Could not generate device pairing QR."));
    } finally {
      setBusy("");
    }
  }

  async function startLiveMirror(member: FamilyMemberSummary) {
    setBusy(`session-${member.member_id}`);
    setError("");
    try {
      const started = await rpc<{ session_id: string; expires_at: string }>("family_mirror_start", {
        family_id: activeId,
        member_id: member.member_id,
      });
      setMirrorTargetName(member.display_name || member.email || "Member");
      setMirrorSession({
        session_id: started.session_id,
        status: "active",
        started_at: new Date().toISOString(),
        expires_at: started.expires_at,
        ended_reason: null,
        frames: 0,
        latest_frame_at: "",
        frame_data_url: null,
      });
      setMirrorModalOpen(true);
      toast("Mirror session started. The member's device now displays a live alert banner.");
      void notifyWorkDone({
        title: "Mirror session started",
        body: `Waiting for ${member.display_name || "member"}'s device to stream screen snapshots.`,
        link: "/family",
      });
    } catch (err) {
      setError(errorMessage(err, "Could not start screen mirroring."));
    } finally {
      setBusy("");
    }
  }

  async function stopLiveMirror() {
    if (!mirrorSession?.session_id) return;
    setBusy("stop-mirror");
    try {
      await rpc("family_mirror_stop", { session_id: mirrorSession.session_id });
      const updated = await rpc<MirrorSessionView>("family_mirror_status", { session_id: mirrorSession.session_id });
      setMirrorSession(updated);
      toast("Screen mirroring session ended.");
    } catch (err) {
      setError(errorMessage(err, "Could not stop mirroring."));
    } finally {
      setBusy("");
    }
  }

  async function toggleDeviceLock(member: FamilyMemberSummary, locked: boolean) {
    await act(
      `lock-${member.member_id}`,
      () =>
        rpc("family_device_lock", {
          family_id: activeId,
          member_id: member.member_id,
          locked,
          reason: locked ? lockReason.trim() || undefined : undefined,
        }),
      locked ? "Device paused. The member's screen is now locked." : "Device unlocked.",
    );
    if (locked) setLockReason("");
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard.");
    } catch {
      toast("Copy failed — select and copy manually.");
    }
  }

  function cleanInviteToken(raw: string): string {
    const trimmed = raw.trim();
    const match = /[?&#]invite=([A-Za-z0-9_-]+)/.exec(trimmed);
    return match ? match[1] : trimmed;
  }

  async function reviewJoin() {
    const token = cleanInviteToken(joinToken);
    if (!token) return;
    setBusy("review");
    setError("");
    try {
      setJoinReview(await rpc("family_invitation_review", { token }));
    } catch (err) {
      setJoinReview(null);
      setError(errorMessage(err, "That invitation is invalid or expired."));
    } finally {
      setBusy("");
    }
  }

  async function acceptJoin() {
    const token = cleanInviteToken(joinToken);
    if (!token) return;
    const ok = await act(
      "accept",
      () => rpc("family_accept", { token }),
      "Joined the family! Supervision stays off unless enabled.",
    );
    if (ok) {
      setJoinToken("");
      setJoinReview(null);
    }
  }

  async function toggleFeature(memberId: string, feature: ChildDeviceFeature, enabled: boolean) {
    const member = members.find((row) => row.member_id === memberId);
    if (!member) return;
    const next = enabled ? [...member.features, feature] : member.features.filter((item) => item !== feature);
    await act(
      `feature-${memberId}-${feature}`,
      () => rpc("family_features_update", { family_id: activeId, member_id: memberId, features: next }),
      enabled ? `${FEATURE_LABEL[feature]} enabled.` : `${FEATURE_LABEL[feature]} disabled.`,
    );
  }

  const joinFamilyCard = (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Link2 size={16} className="text-accent" />
        <h3 className="font-semibold text-ink">Have an invitation link or code?</h3>
      </div>
      <Field
        label="Invitation link or token"
        htmlFor="join-token"
        hint="Paste the full invite URL or code. Sign in with the invited email address to accept."
      >
        <Input
          id="join-token"
          value={joinToken}
          onChange={(event) => {
            setJoinToken(event.target.value);
            setJoinReview(null);
          }}
          placeholder="https://…/family#invite=… or paste code"
        />
      </Field>
      {joinReview ? (
        <Alert tone="info">
          Join <strong>{joinReview.name}</strong> as <strong>{joinReview.role}</strong> · invited by{" "}
          {joinReview.invited_by_name || "a parent"} · expires {new Date(joinReview.expires_at).toLocaleString()}.
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void reviewJoin()} disabled={busy === "review" || !joinToken.trim()}>
          {busy === "review" ? <Loader2 size={14} className="animate-spin" /> : null} Preview invite
        </Button>
        <Button onClick={() => void acceptJoin()} disabled={busy === "accept" || !joinReview}>
          {busy === "accept" ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />} Accept &amp; join
        </Button>
      </div>
    </Card>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => void handleAvatarUpload(e.target.files?.[0])}
      />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Safety &amp; Household</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Family</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            Manage parents, children, cross-account devices, remote pause/lock, and transparent screen mirroring. Every
            member uses their own account, and every supervision action is visible on the device.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void loadOverview(activeId)} disabled={!activeId}>
            <RefreshCw size={15} /> Refresh
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> New family
          </Button>
        </div>
      </header>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {loading ? (
        <Card className="flex items-center gap-2 text-sm text-ink-3">
          <Loader2 size={16} className="animate-spin" /> Loading your family…
        </Card>
      ) : families.length === 0 ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <EmptyState
            icon={<Users size={22} />}
            title="Create your family group"
            body="Start a family as the primary parent, invite members by Resend email or QR popup, and link each person's own phone or computer."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus size={15} /> Create family
              </Button>
            }
          />
          {joinFamilyCard}
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          {/* --- Left rail: family switcher + join another ---------------- */}
          <div className="space-y-4">
            <Card className="h-fit space-y-2 p-3">
              <p className="eyebrow px-1">Your families</p>
              <ul className="space-y-1">
                {families.map((family) => (
                  <li key={family.family_id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(family.family_id)}
                      aria-current={family.family_id === activeId}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors",
                        family.family_id === activeId ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-surface-2",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {family.name || "Family"}
                          {family.is_primary ? (
                            <Crown size={12} className="shrink-0 text-warning" aria-label="Primary parent" />
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-ink-3">
                          {family.member_count} member{family.member_count === 1 ? "" : "s"} ·{" "}
                          {family.is_primary ? "primary parent" : family.role}
                        </span>
                      </span>
                      {family.family_id === activeId ? <Check size={14} className="shrink-0 text-accent" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            {joinToken ? joinFamilyCard : null}
          </div>

          {/* --- Main column --------------------------------------------- */}
          <div className="space-y-5">
            {/* 1. WHO I AM IN THIS FAMILY identity card */}
            {overview && meSummary && me ? (
              <Card className="border-accent/30 bg-surface/90">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3.5">
                    <div className="relative shrink-0">
                      <UserAvatar
                        src={meSummary.avatar_url}
                        name={meSummary.display_name || meSummary.email}
                        size={56}
                      />
                      <button
                        type="button"
                        onClick={() => avatarInputRef.current?.click()}
                        disabled={busy === "avatar"}
                        title="Upload your profile photo"
                        className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full border border-border bg-surface text-ink-2 shadow hover:text-ink"
                      >
                        {busy === "avatar" ? <Loader2 size={11} className="animate-spin" /> : <Camera size={11} />}
                      </button>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                        Who you are in {overview.family.name || "this family"}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        <h2 className="truncate font-display text-lg font-semibold text-ink">
                          {meSummary.display_name || meSummary.email || "You"}
                        </h2>
                        <Badge className={me.role === "parent" ? "!border-accent/40 !text-accent" : ""}>
                          {me.is_primary ? "Primary Parent" : me.role === "parent" ? "Parent" : "Child Member"}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-ink-3">
                        {meSummary.email || "Signed-in account"} ·{" "}
                        {meSummary.devices.length === 0
                          ? "No device linked yet"
                          : `Your devices: ${meSummary.devices.map((d) => d.device_name).join(", ")}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setProfileName(meSummary.display_name || "");
                        setProfileOpen(true);
                      }}
                    >
                      <Edit3 size={14} /> Edit my name
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void openDeviceLinkQr(meSummary)}
                      disabled={busy === `pair-${meSummary.member_id}`}
                    >
                      <QrCode size={14} /> Link my device (QR)
                    </Button>
                  </div>
                </div>
              </Card>
            ) : null}

            {/* 2. FAMILY MEMBERS & DEVICES */}
            {overview ? (
              <Card className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-display text-xl font-semibold text-ink">
                        {overview.family.name || "Family"}
                      </h2>
                      {isParent ? (
                        <button
                          type="button"
                          onClick={() => {
                            setRenameValue(overview.family.name || "");
                            setRenameOpen(true);
                          }}
                          className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
                          aria-label="Rename family"
                          title="Rename family"
                        >
                          <Edit3 size={14} />
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {overview.parent_count} parent{overview.parent_count === 1 ? "" : "s"} ·{" "}
                      {overview.member_count - overview.parent_count} child member
                      {overview.member_count - overview.parent_count === 1 ? "" : "s"} · Click any person to manage
                      role, devices, remote lock, mirroring, and app/browser reports.
                    </p>
                  </div>
                  {isParent ? (
                    <Button
                      onClick={() => {
                        setInvite(null);
                        setInviteOpen(true);
                      }}
                    >
                      <UserPlus size={15} /> Invite member
                    </Button>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {members.map((member) => (
                    <div
                      key={member.member_id}
                      className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-surface-2/50 p-3.5 transition-colors hover:border-border-strong"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setDetailMember(member.member_id);
                          setActivityTab("apps");
                        }}
                        className="flex w-full items-start gap-3 text-left"
                      >
                        <UserAvatar
                          src={member.avatar_url}
                          name={member.display_name || member.email}
                          size={44}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-ink">
                              {member.display_name || member.email || "Family member"}
                            </span>
                            {member.is_primary ? (
                              <Crown size={13} className="shrink-0 text-warning" aria-label="Primary parent" />
                            ) : null}
                            {member.is_me ? <Badge>You</Badge> : null}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-ink-3">
                            {member.email || "Separate MATRIX account"}
                          </span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Badge className={member.role === "parent" ? "!border-accent/40 !text-accent" : ""}>
                              {member.is_primary ? "Primary parent" : member.role}
                            </Badge>
                            {member.device_locked ? (
                              <Badge className="!border-warning/40 !text-warning">
                                <Lock size={10} /> Device paused
                              </Badge>
                            ) : null}
                            {member.role === "child" && member.mirror_state === "granted" ? (
                              <Badge className="!border-success/40 !text-success">Mirror ready</Badge>
                            ) : null}
                          </span>
                        </span>
                      </button>

                      {/* Named devices strip on every member card */}
                      <div className="border-t border-border/70 pt-2">
                        {member.devices.length === 0 ? (
                          <div className="flex items-center justify-between gap-2 text-[11px] text-ink-3">
                            <span>No linked devices yet</span>
                            {isParent || member.is_me ? (
                              <button
                                type="button"
                                onClick={() => void openDeviceLinkQr(member)}
                                className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                              >
                                <QrCode size={12} /> Link via QR
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {member.devices.map((dev) => (
                              <span
                                key={dev.id}
                                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-2"
                              >
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 rounded-full",
                                    dev.live ? "bg-success" : "bg-ink-3/50",
                                  )}
                                />
                                <span className="max-w-[10rem] truncate font-medium text-ink">{dev.device_name}</span>
                                <span className="text-ink-3">({dev.platform})</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            {/* 3. CHILD'S OWN TRANSPARENCY & CONSENT CONTROLS */}
            {me?.role === "child" && overview ? (
              <Card className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="flex items-center gap-2 font-semibold text-ink">
                      <Eye size={16} className="text-accent" /> My device transparency &amp; consent
                    </h3>
                    <p className="mt-1 text-sm text-ink-2">
                      Whenever a parent views your screen, a live banner &amp; notification appear on your device. If
                      you disable mirroring, a parent must re-grant access before it can ever be enabled again.
                    </p>
                  </div>
                  <Badge className={MIRROR_COPY[me.mirror_state].tone}>{MIRROR_COPY[me.mirror_state].label}</Badge>
                </div>
                <p className="text-xs text-ink-3">{MIRROR_COPY[me.mirror_state].body}</p>
                <div className="flex flex-wrap gap-2">
                  {me.mirror_state === "granted" ? (
                    <Button
                      variant="danger"
                      disabled={busy === "consent"}
                      onClick={() =>
                        void act(
                          "consent",
                          () => rpc("family_mirror_consent", { family_id: activeId, consent: "revoke" }),
                          "Screen mirroring disabled. A parent must re-grant access before it can be turned back on.",
                        )
                      }
                    >
                      <EyeOff size={15} /> Disable screen mirroring
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busy === "consent"}
                      onClick={() =>
                        void act(
                          "consent",
                          () => rpc("family_mirror_consent", { family_id: activeId, consent: "grant" }),
                          "Screen mirroring allowed on your side.",
                        )
                      }
                    >
                      <Eye size={15} /> Allow screen mirroring
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy === "ask-parent"}
                    onClick={() =>
                      void act(
                        "ask-parent",
                        () => rpc("family_request_parent_access", { family_id: activeId, kind: "adjust_supervision" }),
                        "Your parent(s) have been notified.",
                      )
                    }
                  >
                    <HelpCircle size={15} /> Request parent review
                  </Button>
                </div>
              </Card>
            ) : null}

            {/* 4. PENDING INVITATIONS (Resend HTTPS email + QR modal) */}
            {isParent && overview ? (
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="flex items-center gap-2 font-semibold text-ink">
                      <Mail size={16} className="text-accent" /> Pending invitations (Resend email + QR)
                    </h3>
                    <p className="mt-1 text-xs text-ink-3">
                      Single-use 7-day links. Clicking <strong>Resend &amp; QR</strong> rotates the token, emails via
                      Resend, and opens the QR code in a popup.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setInvite(null);
                      setInviteOpen(true);
                    }}
                  >
                    <UserPlus size={15} /> Invite by email / QR
                  </Button>
                </div>
                {pendingInvites.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-3 text-sm text-ink-3">
                    No pending invitations right now.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {pendingInvites.map((row) => (
                      <li
                        key={row.invitation_id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/60 p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink">{row.invitee_email}</p>
                          <p className="mt-0.5 text-[11px] text-ink-3">
                            {expiresIn(row.expires_at)} ·{" "}
                            {row.email_status === "accepted_by_provider"
                              ? "Sent via Resend"
                              : row.email_status === "not_configured"
                                ? "Use QR / link (Resend key not set)"
                                : "Email failed — use QR / link"}
                            {row.resend_count ? ` · resent ${row.resend_count}×` : ""}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            disabled={busy === `resend-${row.invitation_id}`}
                            onClick={() => void resendInvitation(row.invitation_id)}
                          >
                            {busy === `resend-${row.invitation_id}` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Send size={14} />
                            )}{" "}
                            Resend &amp; QR
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setConfirm({
                                title: "Revoke this invitation?",
                                body: `The invite link for ${row.invitee_email} will stop working immediately.`,
                                label: "Revoke invitation",
                                run: () =>
                                  act(
                                    `revoke-${row.invitation_id}`,
                                    () => rpc("family_invitation_revoke", { invitation_id: row.invitation_id }),
                                    "Invitation revoked.",
                                  ).then(() => undefined),
                              })
                            }
                          >
                            <Trash2 size={14} /> Revoke
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ) : null}

            {/* 5. JOIN ANOTHER FAMILY */}
            {!joinToken ? joinFamilyCard : null}
          </div>
        </div>
      )}

      {/* --- Modal: Create family ------------------------------------------ */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a family"
        description="You start as the primary parent. You can promote any other member to parent at any time."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createFamily()} disabled={busy === "create" || newName.trim().length < 2}>
              {busy === "create" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={15} />} Create
            </Button>
          </div>
        }
      >
        <Field label="Family name" htmlFor="family-name">
          <Input
            id="family-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="e.g. The Rahman Family"
            maxLength={80}
            autoFocus
          />
        </Field>
      </Modal>

      {/* --- Modal: Rename family ------------------------------------------ */}
      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename family"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveFamilyName()} disabled={busy === "rename" || renameValue.trim().length < 2}>
              Save name
            </Button>
          </div>
        }
      >
        <Field label="Family name" htmlFor="rename-family-input">
          <Input
            id="rename-family-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            maxLength={80}
            autoFocus
          />
        </Field>
      </Modal>

      {/* --- Modal: Edit my display name ----------------------------------- */}
      <Modal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="Edit your display name"
        description="How your name appears to everyone in your family."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setProfileOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveMyDisplayName()} disabled={busy === "profile-name" || !profileName.trim()}>
              Save
            </Button>
          </div>
        }
      >
        <Field label="Display name" htmlFor="my-family-name">
          <Input
            id="my-family-name"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder="e.g. Father / Ayesha"
            maxLength={80}
            autoFocus
          />
        </Field>
      </Modal>

      {/* --- Modal: Create invitation -------------------------------------- */}
      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite a family member"
        description="Sends an email via Resend AND opens a scannable QR popup. Each member signs in with their own MATRIX account."
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void sendInvite()} disabled={busy === "invite" || !inviteEmail.trim()}>
              {busy === "invite" ? <Loader2 size={14} className="animate-spin" /> : <Send size={15} />} Send &amp; show QR
            </Button>
          </div>
        }
      >
        <Field
          label="Invitee email address"
          htmlFor="invite-email"
          hint="They sign in with their own account matching this email — never your account."
        >
          <Input
            id="invite-email"
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="member@example.com"
            autoFocus
          />
        </Field>
      </Modal>

      {/* --- Modal: Invitation QR Popup ------------------------------------ */}
      <Modal
        open={qrOpen && Boolean(invite)}
        onClose={() => setQrOpen(false)}
        title="Family Invitation QR & Link"
        description="Scan with the invited person's phone or copy the direct link."
        size="sm"
      >
        {invite ? (
          <div className="space-y-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={invite.qr_data_url}
              alt="Family invitation QR code"
              className="mx-auto h-60 w-60 rounded-xl bg-white p-2 shadow"
            />
            <p className="text-xs text-ink-3">
              Single-use · {expiresIn(invite.expires_at)} ·{" "}
              {invite.email_status === "accepted_by_provider"
                ? "Email sent via Resend"
                : "Share via QR or link below"}
            </p>
            <code className="block break-all rounded-lg bg-surface-2 p-2 text-left font-mono text-[11px] text-ink-2">
              {invite.invite_url}
            </code>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={() => void copy(invite.invite_url)}>
                <Copy size={14} /> Copy invite link
              </Button>
              <Button
                variant="outline"
                onClick={() => void resendInvitation(invite.invitation_id)}
                disabled={busy === `resend-${invite.invitation_id}`}
              >
                {busy === `resend-${invite.invitation_id}` ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Send size={14} />
                )}{" "}
                Resend email
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* --- Modal: Cross-Account Device Pairing QR Popup ------------------ */}
      <Modal
        open={pairModalOpen && Boolean(pairGrant)}
        onClose={() => setPairModalOpen(false)}
        title={`Link device for ${pairGrant?.member_name || "member"}`}
        description="Cross-account pairing: scan this QR on the member's phone, tablet, or desktop while signed in to THEIR account."
        size="sm"
      >
        {pairGrant ? (
          <div className="space-y-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pairGrant.qr_data_url}
              alt="Cross-account family device QR code"
              className="mx-auto h-60 w-60 rounded-xl bg-white p-2 shadow"
            />
            <p className="text-xs text-ink-3">
              Valid for 1 hour · Single use · No same-account login required.
            </p>
            <code className="block break-all rounded-lg bg-surface-2 p-2 text-left font-mono text-[11px] text-ink-2">
              {pairGrant.qr_payload}
            </code>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={() => void copy(pairGrant.qr_payload)}>
                <Copy size={14} /> Copy pairing code
              </Button>
              {pairGrant.pair_url ? (
                <Button variant="outline" onClick={() => void copy(pairGrant.pair_url!)}>
                  <Link2 size={14} /> Copy pairing URL
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* --- Modal: Live Screen Mirror (ss) Viewer ------------------------- */}
      <Modal
        open={mirrorModalOpen && Boolean(mirrorSession)}
        onClose={() => setMirrorModalOpen(false)}
        title={`Screen Mirror — ${mirrorTargetName}`}
        description="Live snapshots from the member's device. Their screen displays an active mirroring banner while this window is open."
        size="lg"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-3">
              {mirrorSession?.status === "active"
                ? `Active · ${expiresIn(mirrorSession.expires_at)} · ${mirrorSession.frames} frame(s)`
                : `Session ended (${mirrorSession?.ended_reason ?? "completed"})`}
            </span>
            <div className="flex gap-2">
              {mirrorSession?.status === "active" ? (
                <Button variant="danger" onClick={() => void stopLiveMirror()} disabled={busy === "stop-mirror"}>
                  <StopCircle size={14} /> End session
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => setMirrorModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        }
      >
        {mirrorSession ? (
          <div className="space-y-3">
            {mirrorSession.frame_data_url ? (
              <div className="overflow-hidden rounded-xl border border-border bg-black/80">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mirrorSession.frame_data_url}
                  alt={`Live screen mirror of ${mirrorTargetName}`}
                  className="mx-auto max-h-[62vh] w-auto object-contain"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-2/50 py-14 text-center">
                <Loader2 size={22} className={cn("text-accent", mirrorSession.status === "active" && "animate-spin")} />
                <p className="text-sm font-medium text-ink">
                  {mirrorSession.status === "active"
                    ? "Waiting for first screen snapshot (ss)…"
                    : "Mirroring session has ended."}
                </p>
                <p className="max-w-md text-xs text-ink-3">
                  {mirrorTargetName} sees a banner at the top of MATRIX and can click{" "}
                  <strong>Share screen (ss)</strong> (or stream automatically from MATRIX Desktop / Android Companion).
                </p>
              </div>
            )}
            {mirrorSession.latest_frame_at ? (
              <p className="text-right text-[11px] text-ink-3">
                Last snapshot {relative(mirrorSession.latest_frame_at)}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* --- Modal: Member Detail, Supervision, Lock & Telemetry ----------- */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetailMember(null)}
        title={detail?.display_name || detail?.email || "Family Member"}
        description={
          detail
            ? `${detail.is_primary ? "Primary parent" : detail.role} · joined ${
                detail.joined_at ? new Date(detail.joined_at).toLocaleDateString() : "—"
              }`
            : undefined
        }
        size="lg"
      >
        {detail ? (
          <div className="space-y-5">
            {/* Profile banner */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/60 p-3.5">
              <div className="flex min-w-0 items-center gap-3">
                <UserAvatar src={detail.avatar_url} name={detail.display_name || detail.email} size={52} />
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{detail.display_name || "No display name set"}</p>
                  <p className="truncate text-xs text-ink-3">
                    {detail.email || "Separate MATRIX account"}
                    {detail.country ? ` · ${detail.country}` : ""}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge className={detail.role === "parent" ? "!border-accent/40 !text-accent" : ""}>
                      {detail.is_primary ? "Primary parent" : detail.role}
                    </Badge>
                    {detail.is_me ? <Badge>You</Badge> : null}
                    {detail.device_locked ? (
                      <Badge className="!border-warning/40 !text-warning">
                        <Lock size={11} /> Paused
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </div>
              {isParent || detail.is_me ? (
                <Button
                  variant="secondary"
                  onClick={() => void openDeviceLinkQr(detail)}
                  disabled={busy === `pair-${detail.member_id}`}
                >
                  <QrCode size={14} /> Link device (QR)
                </Button>
              ) : null}
            </div>

            {/* Devices list */}
            <section className="space-y-2">
              <h4 className="text-sm font-semibold text-ink">Linked devices ({detail.devices.length})</h4>
              {detail.devices.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-ink-3">
                  No device linked yet. Click <strong>Link device (QR)</strong> above to generate a cross-account QR
                  code for their phone or computer.
                </p>
              ) : (
                <ul className="space-y-2">
                  {detail.devices.map((device) => (
                    <li
                      key={device.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        {device.platform === "web" || device.device_type === "desktop" ? (
                          <Monitor size={16} className="text-ink-3" />
                        ) : (
                          <Smartphone size={16} className="text-ink-3" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{device.device_name}</span>
                          <span className="block text-[11px] text-ink-3">
                            {device.platform} · {device.device_type} · seen {relative(device.last_seen_at)}
                          </span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge className={device.live ? "!border-success/40 !text-success" : ""}>
                          {device.live ? <Wifi size={11} /> : <WifiOff size={11} />} {device.live ? "live" : "offline"}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Child Supervision: checkboxes + Google Family Link Lock + Live Mirror */}
            {detail.role === "child" ? (
              <section className="space-y-3">
                <div>
                  <h4 className="text-sm font-semibold text-ink">Supervision &amp; Family Link Controls</h4>
                  <p className="text-xs text-ink-3">
                    {isParent
                      ? "Toggle which features are active for this child. Changes notify their device immediately."
                      : "Active supervision features for your account."}
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {CHILD_DEVICE_FEATURES.map((feature) => {
                    const enabled = detail.features.includes(feature);
                    return (
                      <label
                        key={feature}
                        className={cn(
                          "flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors",
                          enabled ? "border-accent/40 bg-accent-soft/60" : "border-border",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                          checked={enabled}
                          disabled={!isParent || busy === `feature-${detail.member_id}-${feature}`}
                          onChange={(event) => void toggleFeature(detail.member_id, feature, event.target.checked)}
                        />
                        <span>
                          <span className="block text-sm font-medium text-ink">{FEATURE_LABEL[feature]}</span>
                          <span className="block text-[11px] leading-relaxed text-ink-3">
                            {FEATURE_DESCRIPTION[feature]}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>

                {/* Remote Device Lock (Google Family Link style) */}
                {isParent ? (
                  <div className="space-y-2 rounded-xl border border-border bg-surface-2/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {detail.device_locked ? (
                          <Lock size={15} className="text-warning" />
                        ) : (
                          <Unlock size={15} className="text-accent" />
                        )}
                        <span className="text-sm font-medium text-ink">
                          {detail.device_locked ? "Device is currently paused / locked" : "Remote device pause / turn-off"}
                        </span>
                      </div>
                      {detail.device_locked ? (
                        <Button
                          variant="secondary"
                          disabled={busy === `lock-${detail.member_id}`}
                          onClick={() => void toggleDeviceLock(detail, false)}
                        >
                          <Unlock size={14} /> Unlock device now
                        </Button>
                      ) : (
                        <Button
                          variant="danger"
                          disabled={busy === `lock-${detail.member_id}` || !detail.features.includes("device_lock")}
                          onClick={() => void toggleDeviceLock(detail, true)}
                        >
                          <Lock size={14} /> Pause / lock device
                        </Button>
                      )}
                    </div>
                    {detail.device_locked && detail.device_lock_reason ? (
                      <p className="text-xs text-warning">Reason shown on device: {detail.device_lock_reason}</p>
                    ) : !detail.features.includes("device_lock") ? (
                      <p className="text-[11px] text-ink-3">
                        Check <strong>Remote device lock</strong> above to enable pausing this device.
                      </p>
                    ) : (
                      <Input
                        value={lockReason}
                        onChange={(e) => setLockReason(e.target.value)}
                        maxLength={120}
                        placeholder="Optional lock message (e.g. Bedtime — see you in the morning!)"
                        className="!text-xs"
                      />
                    )}
                  </div>
                ) : null}

                {/* Screen Mirroring control bar */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/60 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Eye size={15} className="text-accent" />
                      <span className="text-sm font-medium text-ink">Screen Mirroring (ss)</span>
                      <Badge className={MIRROR_COPY[detail.mirror_state].tone}>
                        {MIRROR_COPY[detail.mirror_state].label}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-3">{MIRROR_COPY[detail.mirror_state].body}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isParent && detail.mirror_state !== "granted" ? (
                      <Button
                        variant="secondary"
                        disabled={busy === `grant-${detail.member_id}` || !isPrimary}
                        title={!isPrimary ? "Only the primary parent can re-grant mirroring" : undefined}
                        onClick={() =>
                          void act(
                            `grant-${detail.member_id}`,
                            () => rpc("family_mirror_grant", { family_id: activeId, member_id: detail.member_id }),
                            "Mirroring granted. Ask the member to click Allow screen mirroring on their device if needed.",
                          )
                        }
                      >
                        <ShieldCheck size={14} /> Grant mirroring
                      </Button>
                    ) : null}
                    {isParent && detail.mirror_state === "granted" && detail.features.includes("mirror_screen") ? (
                      <Button
                        onClick={() => void startLiveMirror(detail)}
                        disabled={busy === `session-${detail.member_id}`}
                      >
                        {busy === `session-${detail.member_id}` ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Eye size={14} />
                        )}{" "}
                        View live screen (ss)
                      </Button>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            {/* Child / Member Device Telemetry: Screen Time, App Usage, Hidden Apps, Browser History */}
            {detail.activity ? (
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-ink">Device Activity Report</h4>
                  <span className="text-[11px] text-ink-3">
                    Updated {relative(detail.activity.reported_at)}
                  </span>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  <div className="rounded-xl border border-border p-2.5">
                    <p className="flex items-center gap-1 text-[11px] text-ink-3">
                      <Clock size={11} /> Screen time
                    </p>
                    <p className="mt-1 text-base font-semibold text-ink">
                      {Math.floor(detail.activity.screen_time_minutes / 60)}h{" "}
                      {detail.activity.screen_time_minutes % 60}m
                    </p>
                  </div>
                  <div className="rounded-xl border border-border p-2.5">
                    <p className="text-[11px] text-ink-3">Apps used</p>
                    <p className="mt-1 text-base font-semibold text-ink">{detail.activity.apps.length}</p>
                  </div>
                  <div className="rounded-xl border border-border p-2.5">
                    <p className="flex items-center gap-1 text-[11px] text-ink-3">
                      <ShieldAlert size={11} className="text-warning" /> Hidden apps
                    </p>
                    <p className="mt-1 text-base font-semibold text-ink">{detail.activity.hidden_apps.length}</p>
                  </div>
                  <div className="rounded-xl border border-border p-2.5">
                    <p className="flex items-center gap-1 text-[11px] text-ink-3">
                      <Globe size={11} /> Browser visits
                    </p>
                    <p className="mt-1 text-base font-semibold text-ink">{detail.activity.browser_history.length}</p>
                  </div>
                </div>

                <div className="flex gap-1.5 border-b border-border pb-2">
                  <button
                    type="button"
                    onClick={() => setActivityTab("apps")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium",
                      activityTab === "apps" ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    App Usage ({detail.activity.apps.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivityTab("hidden")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium",
                      activityTab === "hidden" ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    Hidden Apps ({detail.activity.hidden_apps.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivityTab("history")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium",
                      activityTab === "history" ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    Browser History ({detail.activity.browser_history.length})
                  </button>
                </div>

                {activityTab === "apps" ? (
                  detail.activity.apps.length === 0 ? (
                    <p className="py-3 text-xs text-ink-3">
                      No app usage entries in this report (or App Usage supervision is turned off).
                    </p>
                  ) : (
                    <ul className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
                      {detail.activity.apps.map((app, index) => (
                        <li
                          key={`${app.name}-${index}`}
                          className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs hover:bg-surface-2"
                        >
                          <span className="min-w-0 truncate text-ink">
                            <span className="font-medium">{app.name}</span>
                            {app.package ? <span className="ml-1.5 text-[11px] text-ink-3">({app.package})</span> : null}
                            {app.hidden ? (
                              <Badge className="ml-2 !border-warning/40 !text-warning">hidden</Badge>
                            ) : null}
                          </span>
                          <span className="shrink-0 font-mono text-ink-2">{app.minutes}m</span>
                        </li>
                      ))}
                    </ul>
                  )
                ) : activityTab === "hidden" ? (
                  detail.activity.hidden_apps.length === 0 ? (
                    <p className="py-3 text-xs text-ink-3">
                      No hidden or launcher-masked apps detected on this device.
                    </p>
                  ) : (
                    <ul className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-warning/30 bg-warn-soft/15 p-2">
                      {detail.activity.hidden_apps.map((app, index) => (
                        <li
                          key={`${app.name}-${index}`}
                          className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs"
                        >
                          <span className="min-w-0 truncate text-ink">
                            <span className="font-medium">{app.name}</span>
                            {app.package ? <span className="ml-1.5 font-mono text-[11px] text-ink-3">{app.package}</span> : null}
                          </span>
                          <span className="shrink-0 font-mono text-warning">{app.minutes}m</span>
                        </li>
                      ))}
                    </ul>
                  )
                ) : detail.activity.browser_history.length === 0 ? (
                  <p className="py-3 text-xs text-ink-3">
                    No browser history reported (or Browser History supervision is turned off).
                  </p>
                ) : (
                  <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
                    {detail.activity.browser_history.map((visit, index) => (
                      <li key={`${visit.url}-${index}`} className="rounded-lg px-2.5 py-1.5 text-xs hover:bg-surface-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-ink">{visit.title || visit.url}</span>
                          {visit.visited_at ? (
                            <span className="shrink-0 text-[10px] text-ink-3">{relative(visit.visited_at)}</span>
                          ) : null}
                        </div>
                        <p className="truncate font-mono text-[11px] text-ink-3">{visit.url}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : detail.role === "child" ? (
              <p className="rounded-xl border border-dashed border-border p-3 text-xs text-ink-3">
                No telemetry snapshot received yet. Link {detail.display_name || "the member"}&apos;s device with{" "}
                <strong>Link device (QR)</strong> and open MATRIX Desktop or the MATRIX Android Companion app to sync
                app usage, hidden apps, and browser history.
              </p>
            ) : null}

            {/* Role management — Primary Parent can promote ANY member to Parent */}
            {isParent && !detail.is_me ? (
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {detail.role === "child" ? (
                  <Button
                    variant="secondary"
                    disabled={busy === `promote-${detail.member_id}`}
                    onClick={() =>
                      void act(
                        `promote-${detail.member_id}`,
                        () => rpc("family_role_change", { family_id: activeId, member_id: detail.member_id, role: "parent" }),
                        `${detail.display_name || "Member"} is now a parent.`,
                      )
                    }
                  >
                    <Crown size={14} /> Make parent
                  </Button>
                ) : null}
                {detail.role === "parent" && !detail.is_primary && isPrimary ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy === `demote-${detail.member_id}`}
                      onClick={() =>
                        setConfirm({
                          title: "Switch this parent to child role?",
                          body: `${detail.display_name || detail.email} will no longer have parent permissions.`,
                          label: "Switch to child",
                          run: () =>
                            act(
                              `demote-${detail.member_id}`,
                              () =>
                                rpc("family_role_change", {
                                  family_id: activeId,
                                  member_id: detail.member_id,
                                  role: "child",
                                }),
                              "Role updated to child.",
                            ).then(() => undefined),
                        })
                      }
                    >
                      Switch to child
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy === `primary-${detail.member_id}`}
                      onClick={() =>
                        setConfirm({
                          title: "Transfer Primary Parent role?",
                          body: `${detail.display_name || detail.email} becomes the primary parent. You remain a parent in this family.`,
                          label: "Transfer primary",
                          run: () =>
                            act(
                              `primary-${detail.member_id}`,
                              () =>
                                rpc("family_primary_transfer", {
                                  family_id: activeId,
                                  member_id: detail.member_id,
                                }),
                              "Primary parent role transferred.",
                            ).then(() => undefined),
                        })
                      }
                    >
                      <Crown size={14} /> Make primary parent
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="danger"
                  disabled={busy === `remove-${detail.member_id}`}
                  onClick={() =>
                    setConfirm({
                      title: "Remove member from family?",
                      body: `${detail.display_name || detail.email} leaves this family and all supervision stops immediately.`,
                      label: "Remove member",
                      run: () =>
                        act(
                          `remove-${detail.member_id}`,
                          () => rpc("family_revoke", { family_id: activeId, member_id: detail.member_id }),
                          "Member removed from family.",
                        ).then(() => {
                          setDetailMember(null);
                        }),
                    })
                  }
                >
                  <Trash2 size={14} /> Remove
                </Button>
              </div>
            ) : null}

            {detail.is_me && !detail.is_primary ? (
              <div className="border-t border-border pt-3">
                <Button
                  variant="outline"
                  onClick={() =>
                    setConfirm({
                      title: "Leave this family?",
                      body: "You will leave the family and any active supervision stops immediately.",
                      label: "Leave family",
                      run: () =>
                        act(
                          "leave",
                          () => rpc("family_revoke", { family_id: activeId, member_id: detail.member_id }),
                          "You left the family.",
                        ).then(() => {
                          setDetailMember(null);
                        }),
                    })
                  }
                >
                  <AlertTriangle size={14} /> Leave family
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmModal
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          if (run) void run();
        }}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.label}
      />
    </div>
  );
}
