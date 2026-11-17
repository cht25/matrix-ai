"use client";

// =============================================================================
// QORVYNA — Cross-account device links (Phase 6).
//
// Two devices owned by DIFFERENT accounts pair here without either account
// signing into the other:
//
//   1. Device A creates an invitation → a short code + QR, valid for 10 min.
//   2. Device B enters the code (or scans it) while signed in to its own account.
//   3. The backend stores only hashes, consumes the invitation once, and both
//      accounts see the link. Either side can revoke it.
//
// The component never receives a stored secret back from the server: the code
// is shown once, at creation, and then cannot be recovered — only revoked.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { Link2, Loader2, QrCode, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import QRCode from "qrcode";
import { Alert, Badge, Button, Card, EmptyState, Field, Input } from "@/components/ui";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import {
  formatLinkCode,
  linkStatusLabel,
  parseLinkInput,
  DEVICE_LINK_TTL_MS,
  type DeviceLinkRow,
  type LinkInvitationRow,
} from "@/lib/device-links";

type Invite = LinkInvitationRow & { qr?: string };

export function CrossAccountLinks() {
  const toast = useToast();
  const [links, setLinks] = useState<DeviceLinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  const load = useCallback(async () => {
    try {
      const rows = await rpc<DeviceLinkRow[]>("device_link_list");
      setLinks(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (cause) {
      setLinks([]);
      setError(cause instanceof RpcCallError ? cause.message : "Linked devices could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The countdown is real: the code stops being accepted when it reaches zero.
  useEffect(() => {
    if (!invite) return;
    const target = new Date(invite.expires_at).getTime();
    const tick = () => setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [invite]);

  async function createInvite() {
    setBusy(true);
    try {
      const created = await rpc<LinkInvitationRow>("device_link_invite_create", { label: "Cross-account device" });
      const qr = await QRCode.toDataURL(created.claim_token, { errorCorrectionLevel: "M", margin: 1, width: 320 }).catch(() => "");
      setInvite({ ...created, qr });
      toast(`Invitation created — share ${formatLinkCode(created.code)} with the other device (expires in ${Math.round(DEVICE_LINK_TTL_MS / 60000)} minutes).`);
    } catch (cause) {
      toast(
        cause instanceof RpcCallError && cause.code === "LINK_RATE_LIMITED"
          ? "Too many invitations in the last hour. Try again later."
          : "Could not create an invitation — nothing was created.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    const token = parseLinkInput(joinCode) ?? joinCode.trim();
    if (!token) {
      setJoinError("Enter the 8-character code from the other device.");
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      const result = await rpc<{ status: string; link_id?: string }>("device_link_claim", { token });
      if (result?.status === "active") {
        toast("Devices linked — both accounts can now see the pairing.");
        setJoinOpen(false);
        setJoinCode("");
        await load();
      } else {
        setJoinError("The other account still has to approve this link.");
      }
    } catch (cause) {
      const code = cause instanceof RpcCallError ? cause.code : "";
      setJoinError(
        code === "LINK_INVALID"
          ? "That code is not valid. Check it on the other device."
          : code === "LINK_EXPIRED"
            ? "That code has expired. Ask the other device for a new one."
            : code === "LINK_ALREADY_USED"
              ? "That code has already been used. Each invitation works once."
              : code === "LINK_SAME_ACCOUNT"
                ? "This device is already signed in to that account. Cross-account linking is for two different accounts."
                : code === "LINK_RATE_LIMITED"
                  ? "Too many attempts. Please wait and try again."
                  : "The link could not be completed. Nothing was changed.",
      );
    } finally {
      setJoining(false);
    }
  }

  async function revoke(link: DeviceLinkRow) {
    try {
      await rpc("device_link_revoke", { link_id: link.id });
      toast("Link revoked for both accounts.");
      await load();
    } catch {
      toast("Could not revoke — nothing was changed.");
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Link2 size={16} /> Cross-Account Device Links
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Connect a device owned by a <strong>different QORVYNA account</strong> — Android, Windows or web. Invitations
            are short-lived, single-use, and only their hashes are stored. Either account can revoke a link at any time.
          </p>
        </div>
        <Badge>{links?.filter((link) => link.status === "active").length ?? 0} active</Badge>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => void createInvite()}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <QrCode className="mr-1.5 h-4 w-4" />} Create invitation
        </Button>
        <Button type="button" variant="outline" onClick={() => setJoinOpen(true)}>
          Enter a code from another device
        </Button>
        <Button type="button" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh
        </Button>
      </div>

      {invite ? (
        <div className="rounded-xl border border-border bg-surface-2/60 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {invite.qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={invite.qr} alt="Pairing QR code" className="h-40 w-40 rounded-lg border border-border bg-white p-2" />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Code for the other device</p>
              <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.2em] text-ink">{formatLinkCode(invite.code)}</p>
              <p className="mt-2 text-xs text-ink-2">
                {remaining > 0
                  ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} · single use.`
                  : "Expired. Create a new invitation."}
              </p>
              <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-3">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                This code is shown once. QORVYNA stores only its hash, so it cannot be recovered later — only revoked.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {links === null ? (
        <div className="flex items-center gap-2 py-3 text-sm text-ink-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading linked devices…</div>
      ) : links.length === 0 ? (
        <EmptyState title="No linked devices yet" body="Create an invitation on one device and enter the code on the other." />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {links.map((link) => (
            <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {linkStatusLabel(link.status)} · account {link.peer_account.slice(0, 8)}…
                </p>
                <p className="text-[11.5px] text-ink-3">
                  Linked {link.created_at ? new Date(link.created_at).toLocaleString() : "recently"}
                  {link.revoked_at ? ` · revoked ${new Date(link.revoked_at).toLocaleString()}` : ""}
                </p>
              </div>
              {link.status === "active" ? (
                <Button type="button" variant="ghost" onClick={() => void revoke(link)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Link a device from another account">
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Enter the code shown on the other device. You stay signed in to <strong>your own</strong> account; the other
            account never sees your sign-in.
          </p>
          <Field label="Pairing code" htmlFor="link-code" hint="8 characters, e.g. ABCD-EFGH. A QR scan opens this automatically.">
            <Input
              id="link-code"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              placeholder="ABCD-EFGH"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              className="font-mono tracking-[0.15em]"
            />
          </Field>
          {joinError ? <Alert tone="danger">{joinError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setJoinOpen(false)}>Cancel</Button>
            <Button type="button" disabled={joining} onClick={() => void join()}>
              {joining ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null} Link devices
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
