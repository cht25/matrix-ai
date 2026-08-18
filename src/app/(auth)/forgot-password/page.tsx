"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { AuthShell, AuthFooterLink } from "@/components/auth-shell";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setSent(true);
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a secure link to set a new password.">
      {sent ? (
        <Alert tone="success">If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your inbox (and spam folder).</Alert>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</Button>
          <AuthFooterLink href="/login">Back to sign in</AuthFooterLink>
        </form>
      )}
    </AuthShell>
  );
}
