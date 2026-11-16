"use client";

// QORVYNA registration: create the Auth account, then go straight into chat.
// Profile details (name, photo, optional identity) live in Settings.

import { useEffect, useRef, useState } from "react";
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
import { PasswordInput } from "@/components/password-input";
import { AuthFooterLink, AuthUnavailable, Divider, OAuthButtons } from "@/components/auth/login-screen";
import {
  postAuthPath,
  rememberPostLoginPath,
  startOAuthSignIn,
  type OAuthProviderId,
} from "@/lib/auth/oauth";
import {
  markSessionEstablished,
  recordPostLoginNavigation,
  resetPostLoginNavigationGuard,
  retryAuthLifecycle,
} from "@/lib/auth/lifecycle";
import { useAuthLifecycle } from "@/components/auth/auth-provider";
import { logAuthDiagnostic } from "@/lib/auth/diagnostics";

export function RegisterForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionRetry, setSessionRetry] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Full-page OAuth: `starting` marks the instant before the browser leaves.
  // The return trip is owned by the centralised auth lifecycle (see
  // src/lib/auth/lifecycle.ts) — this screen only renders its states.
  const [starting, setStarting] = useState<OAuthProviderId | null>(null);
  const { decision, status, error: lifecycleError, retry, onboardingComplete, pendingRedirect } = useAuthLifecycle();

  // Navigate once, only after the lifecycle reports an established session —
  // never while Firebase is still restoring or the redirect is unprocessed.
  const navigatedRef = useRef(false);
  const [loopBlocked, setLoopBlocked] = useState(false);
  useEffect(() => {
    if (decision !== "navigate" || navigatedRef.current || loopBlocked) return;
    if (!recordPostLoginNavigation()) {
      setLoopBlocked(true);
      return;
    }
    navigatedRef.current = true;
    const destination = postAuthPath(onboardingComplete);
    logAuthDiagnostic({ stage: "navigation", method: "session", detail: { path: destination, from: "register", status } });
    window.location.replace(destination);
  }, [decision, onboardingComplete, status, loopBlocked]);

  function clearLoopAndRetry() {
    resetPostLoginNavigationGuard();
    setLoopBlocked(false);
    navigatedRef.current = false;
    void retryAuthLifecycle();
  }

  async function retrySession() {
    setError(null);
    setBusy(true);
    try {
      const session = await mintSessionCookie();
      markSessionEstablished({ uid: session.uid, onboardingComplete: session.onboarding_complete });
      if (!recordPostLoginNavigation()) {
        setLoopBlocked(true);
        setBusy(false);
        return;
      }
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
    if (!fullName.trim()) return setError("Please enter your full name.");
    if (!isValidEmail(email.trim())) return setError("Please enter a valid email address.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    setBusy(true);
    try {
      const auth = fbAuth();
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (fullName.trim()) await updateProfile(cred.user, { displayName: fullName.trim() });
      await sendEmailVerification(cred.user, { url: `${window.location.origin}/verify?next=/chat` });
      const session = await mintSessionCookie();
      markSessionEstablished({ uid: session.uid, onboardingComplete: session.onboarding_complete });
      if (!recordPostLoginNavigation()) {
        setLoopBlocked(true);
        setBusy(false);
        return;
      }
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

  async function oauth(provider: OAuthProviderId) {
    setError(null);
    setSessionRetry(false);
    setStarting(provider);
    rememberPostLoginPath("/chat");
    const result = await startOAuthSignIn(provider, { next: "/chat" });
    if (result.status === "redirecting") return; // browser is already leaving
    setStarting(null);
    if (result.status === "cancelled") return;
    if (result.status === "session-failed") {
      setError(result.message);
      setSessionRetry(true);
      return;
    }
    if (result.status === "error") setError(result.message);
  }

  if (!firebaseBrowserConfigured) {
    return <AuthUnavailable />;
  }

  // INITIALIZING / PROFILE_LOADING → wait. READY/AUTHENTICATED → the
  // navigation effect above is taking over.
  if ((decision === "wait" || decision === "navigate") && !loopBlocked) {
    const finishingTrip = decision === "navigate" || pendingRedirect || status === "PROFILE_LOADING";
    return (
      <div className="space-y-3 py-2 text-center" role="status" aria-live="polite">
        <div className="flex justify-center"><Spinner /></div>
        <p className="text-sm font-medium text-ink">{finishingTrip ? "Finishing sign-in…" : "Restoring your session…"}</p>
        <p className="text-[13px] leading-relaxed text-ink-2">
          {finishingTrip
            ? "Confirming your account and starting your QORVYNA session. This takes a moment — please don't close this tab."
            : "Checking whether you are already signed in to QORVYNA."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {loopBlocked ? (
        <div className="mb-4 space-y-2">
          <Alert tone="danger">
            Your sign-in could not be verified by the server, so QORVYNA stopped returning you to the dashboard to avoid a
            redirect loop. Tap Try again — you will not create a second account.
          </Alert>
          <Button type="button" variant="outline" className="w-full" onClick={clearLoopAndRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {decision === "error" && lifecycleError ? (
        <div className="mb-4 space-y-2">
          <Alert tone="danger">{lifecycleError.message}</Alert>
          <Button type="button" variant="outline" className="w-full" onClick={retry}>
            {lifecycleError.stage === "session-mint" ? "Retry session" : "Retry sign-in"}
          </Button>
        </div>
      ) : null}
      <form onSubmit={submitBasic} className="space-y-4" noValidate>
        <Field label="Full name" htmlFor="full-name">
          <Input id="full-name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" required />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters. Make it a passphrase you can remember.">
          <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {sessionRetry ? (
          <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void retrySession()}>
            {busy ? <Spinner /> : "Retry session"}
          </Button>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? <Spinner /> : "Create account"}</Button>
      </form>
      <Divider />
      {starting ? (
        <Alert tone="info">Redirecting to {starting === "google" ? "Google" : "Facebook"}…</Alert>
      ) : null}
      <OAuthButtons
        onGoogle={() => oauth("google")}
        onFacebook={() => oauth("facebook")}
        redirectingTo={starting}
        disabled={busy}
      />
      <AuthFooterLink href="/login">Already have an account? Sign in</AuthFooterLink>
    </div>
  );
}
