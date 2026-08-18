"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { AuthShell } from "@/components/auth-shell";
import { Alert, Button, Field, Input } from "@/components/ui";

function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      // The reset flow arrives with a session from the recovery link.
      setReady(Boolean(data.session));
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message);
    await supabase.rpc("record_security_event", { p_event_type: "password_changed", p_metadata: {} });
    router.push("/dashboard?reset=1");
    router.refresh();
  }

  if (!ready && !error) {
    return <AuthShell title="Reset your password"><p className="text-sm text-slate-500">Checking your reset link…</p></AuthShell>;
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Make it a passphrase — 3–4 random words, at least 12 characters.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="New password" htmlFor="new-password">
          <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm-password">
          <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Update password"}</Button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthShell title="Reset your password"><p className="text-sm text-slate-500">Loading…</p></AuthShell>}>
      <ResetPasswordInner />
    </Suspense>
  );
}
