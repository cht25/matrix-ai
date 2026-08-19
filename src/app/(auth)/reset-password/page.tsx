"use client";

// Firebase password reset: the email link lands here with
// ?mode=resetPassword&oobCode=…&apiKey=… — we verify the code, set the new
// password, sign the user in, mint the session cookie and log the security
// event (same UX as the old Supabase recovery flow).

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { confirmPasswordReset, signInWithEmailAndPassword, verifyPasswordResetCode } from "firebase/auth";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { mintSessionCookie, rpc } from "@/lib/client/api";
import { AuthShell, AuthUnavailable } from "@/components/auth/login-screen";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";

function ResetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [linkEmail, setLinkEmail] = useState<string | null>(null);
  const [oobCode, setOobCode] = useState<string | null>(null);

  useEffect(() => {
    if (!firebaseBrowserConfigured) return;
    const mode = params.get("mode");
    const code = params.get("oobCode");
    if (mode !== "resetPassword" || !code) {
      setError("This password reset link is invalid or has expired. Request a new one.");
      return;
    }
    verifyPasswordResetCode(fbAuth(), code)
      .then((email) => {
        setLinkEmail(email);
        setOobCode(code);
        setReady(true);
      })
      .catch(() => setError("This password reset link is invalid or has expired. Request a new one."));
  }, [params]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    if (!oobCode || !linkEmail) return setError("This password reset link is invalid or has expired.");
    setBusy(true);
    try {
      await confirmPasswordReset(fbAuth(), oobCode, password);
      await signInWithEmailAndPassword(fbAuth(), linkEmail, password).catch(() => {});
      await mintSessionCookie().catch(() => {});
      await rpc("record_security_event", { event_type: "password_reset", metadata: {} }).catch(() => {});
      router.push("/chat?reset=1");
      router.refresh();
    } catch {
      setBusy(false);
      setError("We couldn't update your password. The link may have expired — request a new one.");
    }
  }

  if (!firebaseBrowserConfigured) {
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
