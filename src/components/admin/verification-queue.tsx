"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Badge, Button, Card, Input, Spinner, Textarea } from "@/components/ui";
import { formatDate } from "@/lib/utils";

type VerificationItem = {
  id: string; user_id: string; verification_type: string; verification_status: string;
  verification_reference: string; created_at: string;
};

export function VerificationQueue({ codes }: { codes: Set<string> }) {
  const [items, setItems] = useState<VerificationItem[] | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    const { data } = await supabase
      .from("identity_verifications")
      .select("id, user_id, verification_type, verification_status, verification_reference, created_at")
      .eq("verification_status", "pending_review")
      .order("created_at", { ascending: true });
    setItems((data ?? []) as VerificationItem[]);
  }

  useEffect(() => { if (codes.has("verification.review")) void load(); }, [codes]);

  async function review(id: string, approve: boolean) {
    const supabase = createClient();
    const { error } = await supabase.rpc("review_identity_verification", {
      p_verification_id: id,
      p_approve: approve,
      p_reason: reason[id] ?? "",
    });
    if (error) setMsg(error.message);
    else {
      setMsg(approve ? "Approved — the user's age_verified flag was set server-side." : "Rejected with reason.");
      void load();
    }
  }

  if (!codes.has("verification.review")) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>verification.review</strong> permission.</p></Card>;
  }
  if (!items) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading…</Card>;
  if (items.length === 0) return <Card><p className="text-sm text-ink-3">🎉 No pending age verifications.</p></Card>;

  return (
    <div className="space-y-3">
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      {items.map((v) => (
        <Card key={v.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-warning/30 bg-warning-soft text-warning">pending_review</Badge>
            <span className="font-mono text-xs text-ink-3">{v.user_id}</span>
          </div>
          <p className="mt-2 text-sm text-ink-2">
            Type: {v.verification_type} · Submitted {formatDate(v.created_at)} · Reference: <code className="rounded bg-surface-2 px-1 text-xs">{v.verification_reference}</code>
          </p>
          <p className="mt-1 text-xs text-ink-3">
            The document itself lives in the private <code className="rounded bg-surface-2 px-1">identity-documents</code> bucket — download it via storage to review.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              value={reason[v.id] ?? ""}
              onChange={(e) => setReason((r) => ({ ...r, [v.id]: e.target.value }))}
              placeholder="Review note / rejection reason (required for rejection)"
              className="max-w-sm"
            />
            <Button onClick={() => void review(v.id, true)}>Approve</Button>
            <Button variant="danger" onClick={() => void review(v.id, false)}>Reject</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

type ConsentItem = {
  id: string; user_id: string; status: string; consent_method: string;
  guardian_name: string; guardian_email: string; created_at: string;
};

export function ConsentQueue({ codes }: { codes: Set<string> }) {
  const [items, setItems] = useState<ConsentItem[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    const { data } = await supabase
      .from("guardian_consents")
      .select("id, user_id, status, consent_method, guardian_name, guardian_email, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    setItems((data ?? []) as ConsentItem[]);
  }

  useEffect(() => { if (codes.has("consent.review")) void load(); }, [codes]);

  async function review(userId: string, approve: boolean) {
    const supabase = createClient();
    const { error } = await supabase.rpc("review_guardian_consent", {
      p_user_id: userId,
      p_approve: approve,
      p_reason: "admin review",
    });
    if (error) setMsg(error.message);
    else { setMsg(approve ? "Consent approved." : "Consent revoked."); void load(); }
  }

  if (!codes.has("consent.review")) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>consent.review</strong> permission.</p></Card>;
  }
  if (!items) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading…</Card>;
  if (items.length === 0) return <Card><p className="text-sm text-ink-3">🎉 No pending consents.</p></Card>;

  return (
    <div className="space-y-3">
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      {items.map((c) => (
        <Card key={c.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-warning/30 bg-warning-soft text-warning">pending</Badge>
            <span className="font-mono text-xs text-ink-3">{c.user_id}</span>
          </div>
          <p className="mt-2 text-sm text-ink-2">
            Guardian: <strong>{c.guardian_name || "—"}</strong> ({c.guardian_email || "no email"}) · method: {c.consent_method}
          </p>
          <p className="mt-1 text-xs text-ink-3">Submitted {formatDate(c.created_at)}</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void review(c.user_id, true)}>Approve</Button>
            <Button variant="danger" onClick={() => void review(c.user_id, false)}>Revoke</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
