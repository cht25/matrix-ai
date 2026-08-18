"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient, supabaseBrowserConfigured } from "@/lib/supabase/browser";
import { AuthShell, AuthUnavailable } from "@/components/auth/login-screen";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";

function ResetPasswordInner() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!supabaseBrowserConfigured) return;
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => setReady(Boolean(data.session)));
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
    if (error) return setError("We couldn't update your password. The link may have expired — request a new one.");
    await supabase.rpc("record_security_event", { p_event_type: "password_changed", p_metadata: {} });
    router.push("/chat?reset=1");
    router.refresh();
  }

  if (!supabaseBrowserConfigured) {
    return (
      <AuthShell title="Reset password">
        <AuthUnavailable />
      </AuthShell>
    );
  }

  if (!ready && !error) {
    return <AuthShell title="Reset password"><p className="text-sm text-ink-2">Checking your reset link…</p></AuthShell>;
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
        <Button type="submit" className="w-full" disabled={busy}>{busy ? <Spinner /> : "Update password"}</Button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
