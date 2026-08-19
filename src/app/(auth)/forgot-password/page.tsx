"use client";

import { useState } from "react";
import Link from "next/link";
import { sendPasswordResetEmail } from "firebase/auth";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { AuthShell, AuthUnavailable } from "@/components/auth/login-screen";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await sendPasswordResetEmail(fbAuth(), email, { url: `${window.location.origin}/reset-password` });
    } catch {
      setBusy(false);
      return setError("We couldn't send a reset link. Please try again.");
    }
    setBusy(false);
    setSent(true);
  }

  if (!firebaseBrowserConfigured) {
    return (
      <AuthShell title="Reset password">
        <AuthUnavailable />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset password" subtitle="We'll email you a secure link to set a new password.">
      {sent ? (
        <Alert tone="success">
          If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your inbox (and spam folder).
        </Alert>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button type="submit" className="w-full" disabled={busy}>{busy ? <Spinner /> : "Send reset link"}</Button>
          <p className="text-center text-sm">
            <Link href="/login" className="font-medium text-accent hover:text-accent-2">Back to sign in</Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
