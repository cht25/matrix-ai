"use client";

// MATRIX registration: create the Auth account, then finish remaining
// required fields (DOB + birth certificate number) on /onboarding.

import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
} from "firebase/auth";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { describeAuthError } from "@/lib/firebase/auth-errors";
import { mintSessionCookie } from "@/lib/client/api";
import { isValidEmail } from "@/lib/utils";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";
import { AuthFooterLink, AuthUnavailable, Divider, OAuthButtons } from "@/components/auth/login-screen";
import { consumeOAuthRedirect, postAuthPath, signInWithOAuth } from "@/lib/auth/oauth";

export function RegisterForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionRetry, setSessionRetry] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await consumeOAuthRedirect();
      if (cancelled || !result) return;
      if (result.status === "cancelled") return;
      if (result.status === "ok") {
        window.location.href = postAuthPath(result.onboardingComplete);
        return;
      }
      if (result.status === "session-failed") {
        setError(result.message);
        setSessionRetry(true);
        return;
      }
      if (result.status === "error") setError(result.message);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function retrySession() {
    setError(null);
    setBusy(true);
    try {
      const session = await mintSessionCookie();
      window.location.href = postAuthPath(session.onboarding_complete);
    } catch {
      setError("Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.");
      setSessionRetry(true);
      setBusy(false);
    }
  }

  async function submitBasic(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidEmail(email)) return setError("Please enter a valid email address.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    setBusy(true);
    try {
      const auth = fbAuth();
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (fullName.trim()) await updateProfile(cred.user, { displayName: fullName.trim() });
      await sendEmailVerification(cred.user, { url: `${window.location.origin}/verify?next=/onboarding` });
      const session = await mintSessionCookie();
      window.location.href = postAuthPath(session.onboarding_complete);
    } catch (err) {
      setBusy(false);
      const code = (err as { code?: string }).code ?? "";
      if (code === "SESSION_MINT_FAILED" || code === "INTERNAL") {
        setSessionRetry(true);
        return setError("Your account was created, but the server could not create your session. Tap Retry session.");
      }
      if (code === "auth/email-already-in-use") return setError("An account with this email already exists. Try signing in.");
      if (code === "auth/weak-password") return setError("Password must be at least 8 characters.");
      if (code === "auth/operation-not-allowed") return setError("Email sign-up is not enabled in Firebase yet (Authentication → Sign-in method).");
      return setError(describeAuthError(err, "We couldn't create your account. Please try again."));
    }
  }

  async function oauth(provider: "google" | "facebook") {
    setError(null);
    setSessionRetry(false);
    const result = await signInWithOAuth(provider);
    if (result.status === "cancelled" || result.status === "redirecting") return;
    if (result.status === "ok") {
      window.location.href = postAuthPath(result.onboardingComplete);
      return;
    }
    if (result.status === "session-failed") {
      setError(result.message);
      setSessionRetry(true);
      return;
    }
    setError(result.message);
  }

  if (!firebaseBrowserConfigured) {
    return <AuthUnavailable />;
  }

  return (
    <div>
      <form onSubmit={submitBasic} className="space-y-4" noValidate>
        <h1 className="text-lg font-bold text-ink">Create your MATRIX account</h1>
        <p className="text-sm leading-relaxed text-ink-2">
          After this step we only ask for your date of birth and birth certificate number — not a photo of any document.
        </p>
        <Field label="Full name" htmlFor="full-name">
          <Input id="full-name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" required />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters. Make it a passphrase you can remember.">
          <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {sessionRetry ? (
          <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void retrySession()}>
            {busy ? <Spinner /> : "Retry session"}
          </Button>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? <Spinner /> : "Continue"}</Button>
      </form>
      <Divider />
      <OAuthButtons onGoogle={() => oauth("google")} onFacebook={() => oauth("facebook")} />
      <AuthFooterLink href="/login">Already have an account? Sign in</AuthFooterLink>
    </div>
  );
}
