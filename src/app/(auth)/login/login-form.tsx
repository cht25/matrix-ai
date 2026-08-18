"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";
import { AuthDivider, AuthFooterLink, OAuthButtons } from "@/components/auth-shell";
import Link from "next/link";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaFactor, setMfaFactor] = useState<{ factorId: string; challengeId: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const supabase = createClient();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message === "Invalid login credentials" ? "Incorrect email or password." : error.message);
      setBusy(false);
      return;
    }
    // MFA-protected account: no session yet — challenge the TOTP factor.
    if (!data.session && data.user?.factors?.length) {
      const factorId = data.user.factors[0].id;
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError || !challengeData) {
        setError(challengeError?.message ?? "Could not start MFA verification.");
        setBusy(false);
        return;
      }
      setMfaFactor({ factorId, challengeId: challengeData.id });
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function handleMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaFactor) return;
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.mfa.verify({
      factorId: mfaFactor.factorId,
      challengeId: mfaFactor.challengeId,
      code: mfaCode,
    });
    if (error || !data) {
      setError(error?.message ?? "Invalid verification code.");
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  function handleGoogle() {
    const supabase = createClient();
    supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/verify?next=${next}` } });
  }
  function handleFacebook() {
    const supabase = createClient();
    supabase.auth.signInWithOAuth({ provider: "facebook", options: { redirectTo: `${window.location.origin}/verify?next=${next}` } });
  }

  if (mfaFactor) {
    return (
      <form onSubmit={handleMfa} className="space-y-4">
        <Alert tone="info">This account uses two-factor authentication. Enter the 6-digit code from your authenticator app.</Alert>
        <Field label="Authentication code" htmlFor="mfa-code">
          <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="000000" required />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Spinner /> : "Verify & sign in"}
        </Button>
      </form>
    );
  }

  return (
    <div>
      <form onSubmit={handleLogin} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Spinner /> : "Sign in"}
        </Button>
        <p className="text-right text-sm">
          <Link href="/forgot-password" className="font-medium text-brand-600 hover:text-brand-700">Forgot password?</Link>
        </p>
      </form>

      <AuthDivider />
      <OAuthButtons onGoogle={handleGoogle} onFacebook={handleFacebook} />
      <AuthFooterLink href="/register">New here? Create an account</AuthFooterLink>
    </div>
  );
}
