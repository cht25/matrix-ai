"use client";

// MATRIX Family — parent/child relationship management. Every mutation goes
// through /api/rpc where roles and membership are re-verified server-side;
// this UI never assumes a permission the backend has not granted.

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input } from "@/components/ui";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Users } from "lucide-react";

type Invitation = { invitation_id: string; token: string; expires_at: string; qr_data_url: string; email_status: string };

type Family = { family_id: string; role: "parent" | "child"; name: string; member_count: number };
type Member = { member_id: string; user_id: string; role: "parent" | "child"; invited_by: string | null; joined_at: string };

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof RpcCallError) return err.code.replace(/_/g, " ").toLowerCase();
  return fallback;
}

export function FamilyClient() {
  const toast = useToast();
  const [families, setFamilies] = useState<Family[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<Record<string, string>>({});
  const [inviteResult, setInviteResult] = useState<Record<string, Invitation>>({});
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [acceptToken, setAcceptToken] = useState("");
  const [review, setReview] = useState<{ name: string; role: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFamilies(await rpc<Family[]>("family_list"));
    } catch (err) {
      setError(errorMessage(err, "Could not load families."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("invite");
    if (token) {
      setAcceptToken(token);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  async function loadMembers(familyId: string) {
    try {
      const list = await rpc<Member[]>("family_members", { family_id: familyId });
      setMembers((m) => ({ ...m, [familyId]: list }));
    } catch (err) {
      toast(errorMessage(err, "Could not load members."));
    }
  }

  async function createFamily() {
    if (name.trim().length < 2) return;
    setBusy(true);
    try {
      await rpc("family_create", { name: name.trim() });
      setName("");
      toast("Family created. You are its parent.");
      await load();
    } catch (err) {
      toast(errorMessage(err, "Could not create family."));
    } finally {
      setBusy(false);
    }
  }

  async function invite(familyId: string) {
    const email = (inviteEmail[familyId] ?? "").trim();
    if (!email) return;
    setBusy(true);
    try {
      const res = await rpc<Invitation>("family_invite", {
        family_id: familyId,
        invitee_email: email,
      });
      setInviteResult((r) => ({ ...r, [familyId]: res }));
      setInviteEmail((e) => ({ ...e, [familyId]: "" }));
      toast(res.email_status === "accepted_by_provider" ? "Invitation submitted to email provider. Delivery is not yet confirmed." : "Invitation created. Email unavailable — share the QR or code.");
    } catch (err) {
      toast(errorMessage(err, "Could not create invitation."));
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvite(familyId: string) {
    const invitation = inviteResult[familyId];
    if (!invitation) return;
    setBusy(true);
    try {
      await rpc("family_invitation_revoke", { invitation_id: invitation.invitation_id });
      setInviteResult((current) => { const next = { ...current }; delete next[familyId]; return next; });
      toast("Invitation revoked.");
    } catch (err) { toast(errorMessage(err, "Could not revoke invitation.")); }
    finally { setBusy(false); }
  }

  async function reviewInvite() {
    setBusy(true);
    try {
      setReview(await rpc("family_invitation_review", { token: acceptToken.trim() }));
    } catch (err) { toast(errorMessage(err, "Could not review invitation.")); }
    finally { setBusy(false); }
  }

  async function accept() {
    if (!acceptToken.trim()) return;
    setBusy(true);
    try {
      const res = await rpc<{ family_id: string; role: string }>("family_accept", { token: acceptToken.trim() });
      setAcceptToken("");
      setReview(null);
      toast(`Joined family as ${res.role}.`);
      await load();
    } catch (err) {
      toast(errorMessage(err, "Invitation invalid or expired."));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(familyId: string, memberId: string) {
    setBusy(true);
    try {
      await rpc("family_revoke", { family_id: familyId, member_id: memberId });
      toast("Access revoked.");
      await load();
      await loadMembers(familyId);
    } catch (err) {
      toast(errorMessage(err, "Could not revoke."));
    } finally {
      setBusy(false);
    }
  }

  async function promote(familyId: string, memberId: string) {
    setBusy(true);
    try {
      await rpc("family_role_change", { family_id: familyId, member_id: memberId, role: "parent" });
      toast("Member is now a parent.");
      await loadMembers(familyId);
    } catch (err) {
      toast(errorMessage(err, "Could not change role."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Family</h1>
        <p className="mt-1 text-ink-2">
          Link parent and child accounts. Device supervision requires separately implemented native capabilities and explicit consent; children keep their own
          private AI workspace. All access is explicit, visible and revocable — there is no hidden monitoring.
        </p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold text-ink">Create a family</h2>
          <Field label="Family name" htmlFor="family-name">
            <Input id="family-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Rahman family" maxLength={80} />
          </Field>
          <Button onClick={createFamily} disabled={busy || name.trim().length < 2}>Create family</Button>
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className="font-semibold text-ink">Join with an invitation code</h2>
          <Field label="One-time invitation code" htmlFor="accept-token" hint="Review the invitation before accepting. You must sign in with the invited, verified email. Joining does not grant screen capture or monitoring permission.">
            <Input id="accept-token" value={acceptToken} onChange={(e) => { setAcceptToken(e.target.value); setReview(null); }} placeholder="Paste invitation code" />
          </Field>
          {review ? <Alert tone="info">Join <strong>{review.name}</strong> as {review.role}. Expires {new Date(review.expires_at).toLocaleString()}. No device monitoring permissions are granted.</Alert> : null}
          <Button variant="secondary" onClick={review ? accept : reviewInvite} disabled={busy || !acceptToken.trim()}>{review ? "Accept invitation" : "Review invitation"}</Button>
        </Card>
      </div>

      {loading ? (
        <Card className="p-4 text-sm text-ink-3">Loading families…</Card>
      ) : families.length === 0 ? (
        <EmptyState icon={<Users size={22} />} title="No families yet" body="Create a family to invite child accounts, or join one with an invitation code." />
      ) : (
        families.map((f) => (
          <Card key={f.family_id} className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold text-ink">{f.name}</h2>
                <p className="text-sm text-ink-3">
                  {f.member_count} member(s) · you are <Badge>{f.role}</Badge>
                </p>
              </div>
              <Button variant="secondary" onClick={() => void loadMembers(f.family_id)}>
                {members[f.family_id] ? "Refresh members" : "View members"}
              </Button>
            </div>

            {f.role === "parent" ? (
              <div className="space-y-2 border-t border-border pt-3">
                <Field label="Invite a child by email" htmlFor={`invite-${f.family_id}`}>
                  <div className="flex gap-2">
                    <Input
                      id={`invite-${f.family_id}`}
                      type="email"
                      value={inviteEmail[f.family_id] ?? ""}
                      onChange={(e) => setInviteEmail((v) => ({ ...v, [f.family_id]: e.target.value }))}
                      placeholder="child@example.com"
                    />
                    <Button onClick={() => void invite(f.family_id)} disabled={busy || !(inviteEmail[f.family_id] ?? "").trim()}>
                      Invite
                    </Button>
                  </div>
                </Field>
                {inviteResult[f.family_id] ? (
                  <div className="space-y-3">
                  <img src={inviteResult[f.family_id].qr_data_url} width={256} height={256} alt="Single-use family invitation QR code" className="rounded-lg" />
                  <Alert tone="info">
                    Email: {inviteResult[f.family_id].email_status.replace(/_/g, " ")}.<br />
                    One-time code (expires {new Date(inviteResult[f.family_id].expires_at).toLocaleString()}):{" "}
                    <code className="break-all font-mono text-xs">{inviteResult[f.family_id].token}</code>
                  </Alert>
                  <Button variant="danger" disabled={busy} onClick={() => void revokeInvite(f.family_id)}>Revoke invitation</Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {members[f.family_id] ? (
              <ul className="space-y-2 border-t border-border pt-3">
                {members[f.family_id].map((m) => (
                  <li key={m.member_id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-3 py-2">
                    <div>
                      <p className="font-mono text-xs text-ink">{m.user_id}</p>
                      <p className="text-xs text-ink-3">
                        <Badge>{m.role}</Badge> joined {m.joined_at ? new Date(m.joined_at).toLocaleDateString() : "—"}
                      </p>
                    </div>
                    {f.role === "parent" && m.role === "child" ? (
                      <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => void promote(f.family_id, m.member_id)} disabled={busy}>
                          Make parent
                        </Button>
                        <Button variant="danger" onClick={() => void revoke(f.family_id, m.member_id)} disabled={busy}>
                          Revoke
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        ))
      )}
    </div>
  );
}
