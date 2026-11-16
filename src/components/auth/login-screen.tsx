"use client";

// QORVYNA authentication.
// The brand lockup (emblem, wordmark, tagline) is the identity; the form is a
// single quiet card with the primary action in brand blue and OAuth as
// secondary actions. One column at every width, so nothing reflows on phones.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  signInWithEmailAndPassword,
  getMultiFactorResolver,
  type MultiFactorResolver,
} from "firebase/auth";
import { TotpMultiFactorGenerator } from "firebase/auth";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { describeAuthError } from "@/lib/firebase/auth-errors";
import { MAX_AGE, MIN_AGE, isValidEmail } from "@/lib/utils";
import {
  completeAuthenticatedSession,
  consumeOAuthRedirect,
  oauthRedirectPending,
  postAuthPath,
  rememberPostLoginPath,
  startOAuthSignIn,
  type OAuthProviderId,
} from "@/lib/auth/oauth";
import { BrandLockup } from "@/components/logo";
import { BRAND, BRAND_PILLARS } from "@/lib/brand";
import { PasswordInput } from "@/components/password-input";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";
import { ThemeToggle } from "@/lib/theme";
import { ServerProblem } from "@/components/server-problem";
import { failureCopy } from "@/lib/api-errors";

/** Rendered (instead of any auth form) when the deployment has no Firebase
 *  configuration — authentication honestly cannot work, so we say so. */
export function AuthUnavailable() {
  return (
    <ServerProblem
      failure={{
        ...failureCopy("not-configured"),
        detail:
          "QORVYNA is not connected to its backend services yet, so authentication is unavailable. The administrator must set the NEXT_PUBLIC_FIREBASE_* variables and redeploy.",
      }}
    />
  );
}

export function LoginScreen() {
  return (
    <AuthShell>
      <LoginForm />
    </AuthShell>
  );
}

export function AuthShell({ children, title, subtitle }: { children: React.ReactNode; title?: string; subtitle?: string }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 pb-10 pt-16">
      <div className="absolute right-3 top-3 pt-[env(safe-area-inset-top)]"><ThemeToggle compact /></div>
      <div className="mb-8"><BrandLockup /></div>
      {title ? (
        <div className="mb-6 max-w-sm text-center">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle ? <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{subtitle}</p> : null}
        </div>
      ) : null}
      <div className="card w-full max-w-sm p-5 shadow-[var(--shadow-pop)] sm:p-7">{children}</div>
      <ul className="mt-8 flex max-w-sm flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[11.5px] text-ink-3" aria-label={`${BRAND.name} ecosystem`}>
        {BRAND_PILLARS.filter((pillar) => pillar.status === "live").map((pillar, index) => (
          <li key={pillar.id} className="flex items-center gap-2.5">
            {/* On the narrowest phones the list wraps; a rule at the start of a line would look like a stray character. */}
            {index > 0 ? <span className="h-3 w-px bg-border-strong max-[359px]:hidden" aria-hidden="true" /> : null}
            {pillar.label}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-ink-3">
        For ages {MIN_AGE}–{MAX_AGE} · Operated by {BRAND.operator}
      </p>
    </div>
  );
}

export function Divider() {
  return (
    <div className="my-6 flex items-center gap-4 text-[10.5px] font-medium uppercase tracking-[0.2em] text-ink-3" aria-hidden="true">
      <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Google / Facebook buttons.
 *
 * Both providers use Firebase's full-page redirect, so the moment one is
 * clicked the browser is about to leave this page. `redirectingTo` keeps that
 * state visible and disables the buttons so a second click cannot start a
 * competing redirect (the classic cause of the auth-state ping-pong).
 */
export function OAuthButtons({
  onGoogle,
  onFacebook,
  redirectingTo = null,
  disabled = false,
}: {
  onGoogle: () => void | Promise<void>;
  onFacebook: () => void | Promise<void>;
  redirectingTo?: OAuthProviderId | null;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<OAuthProviderId | null>(null);
  async function run(which: OAuthProviderId, fn: () => void | Promise<void>) {
    setBusy(which);
    try {
      await fn();
    } finally {
      // After a redirect starts the browser is unloading; leaving `busy` set
      // would be invisible anyway, but resetting keeps the form usable if the
      // redirect was refused synchronously.
      setBusy(null);
    }
  }
  const active = redirectingTo ?? busy;
  const locked = disabled || redirectingTo !== null || busy !== null;
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <button
        type="button"
        disabled={locked}
        onClick={() => { void run("google", onGoogle); }}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {active === "google" ? <Spinner /> : <GoogleIcon />} Google
      </button>
      <button
        type="button"
        disabled={locked}
        onClick={() => { void run("facebook", onFacebook); }}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {active === "facebook" ? <Spinner /> : <FacebookIcon />} Facebook
      </button>
    </div>
  );
}

export function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52Z" />
    </svg>
  );
}

export function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#1877F2" d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.95h-1.52c-1.49 0-1.96.92-1.96 1.87V12h3.33l-.53 3.47h-2.8v8.38A12 12 0 0 0 24 12Z" />
    </svg>
  );
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/chat";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<MultiFactorResolver | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  const [sessionRetry, setSessionRetry] = useState(false);
  // Full-page OAuth state. `finishing` is the return trip from Google (the page
  // has just reloaded with a result to consume); `starting` is the instant
  // before the browser leaves for the consent screen.
  const [finishing, setFinishing] = useState(false);
  const [starting, setStarting] = useState<OAuthProviderId | null>(null);

  async function finishSignIn() {
    const session = await completeAuthenticatedSession();
    window.location.href = postAuthPath(session.onboardingComplete, next);
  }

  async function retrySession() {
    setError(null);
    setBusy(true);
    try {
      await finishSignIn();
    } catch {
      setError("Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.");
      setSessionRetry(true);
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!firebaseBrowserConfigured) return;
    let cancelled = false;
    // Show the loading state only when we know a redirect is coming back —
    // otherwise every visit to /login would flash a spinner before the form.
    if (oauthRedirectPending()) setFinishing(true);
    (async () => {
      // consumeOAuthRedirect() is memoised per page load: it can be awaited
      // here, in <AuthRedirectWatcher /> and on /verify without ever minting a
      // second session or draining the result twice.
      const result = await consumeOAuthRedirect();
      if (cancelled) return;
      setFinishing(false);
      setStarting(null);
      if (!result || result.status === "cancelled" || result.status === "redirecting") return;
      if (result.status === "ok") {
        // A link operation belongs to Settings, never to a login navigation.
        if (result.operation === "link") return;
        setBusy(true);
        // replace(): the redirect URL must not stay in history, or "Back"
        // re-enters the login screen and looks like a redirect loop.
        window.location.replace(postAuthPath(result.onboardingComplete, next));
        return;
      }
      if (result.status === "session-failed") {
        setError(result.message);
        setSessionRetry(true);
        return;
      }
      setError(result.message);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!firebaseBrowserConfigured) return;
    if (!email.trim()) return setError("Please enter your email address.");
    if (!isValidEmail(email.trim())) return setError("Please enter a valid email address.");
    if (!password) return setError("Please enter your password.");
    setError(null);
    setBusy(true);
    try {
      await signInWithEmailAndPassword(fbAuth(), email.trim(), password);
      await finishSignIn();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "SESSION_MINT_FAILED" || (err as { status?: number }).status === 500) {
        setError("Signed in with Firebase, but the server could not create your session. Check FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY on the host and retry.");
        setBusy(false);
        return;
      }
      if (code === "auth/multi-factor-auth-required") {
        const resolver = getMultiFactorResolver(fbAuth(), err as never);
        if (resolver.hints.some((h) => h.factorId === "totp")) {
          setMfa(resolver);
          setBusy(false);
          return;
        }
        setError("This account uses a sign-in method that isn't available here.");
        setBusy(false);
        return;
      }
      const invalid = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-login-credentials"];
      setError(invalid.includes(code) ? "Incorrect email or password." : describeAuthError(err, "We couldn't sign you in. Please try again."));
      setBusy(false);
    }
  }

  async function handleMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfa) return;
    setError(null);
    setBusy(true);
    try {
      const hint = mfa.hints.find((h) => h.factorId === "totp");
      if (!hint) throw new Error("no totp factor");
      const assertion = await TotpMultiFactorGenerator.assertionForSignIn(hint.uid, mfaCode.trim());
      await mfa.resolveSignIn(assertion);
      await finishSignIn();
    } catch {
      setError("That verification code didn't work. Please try again.");
      setBusy(false);
    }
  }

  async function oauth(provider: OAuthProviderId) {
    setError(null);
    setSessionRetry(false);
    setStarting(provider);
    rememberPostLoginPath(next);
    const result = await startOAuthSignIn(provider, { next });
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

  if (finishing) {
    return (
      <div className="space-y-3 py-2 text-center" role="status" aria-live="polite">
        <div className="flex justify-center"><Spinner /></div>
        <p className="text-sm font-medium text-ink">Finishing sign-in…</p>
        <p className="text-[13px] leading-relaxed text-ink-2">
          Confirming your account and starting your QORVYNA session. This takes a moment — please don&apos;t close this tab.
        </p>
      </div>
    );
  }

  if (mfa) {
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
      <form onSubmit={handleLogin} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label="Password" htmlFor="password">
          <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {sessionRetry ? (
          <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void retrySession()}>
            {busy ? <Spinner /> : "Retry session"}
          </Button>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Spinner /> : "Sign In"}
        </Button>
        <p className="text-right text-[13px]">
          <Link href="/forgot-password" className="text-ink-2 transition-colors hover:text-ink">
            Forgot password?
          </Link>
        </p>
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
      <p className="mt-6 text-center text-[13px] text-ink-2">
        Don't have an account?{" "}
        <Link href="/register" className="font-medium text-ink transition-colors hover:text-accent">
          Create account
        </Link>
      </p>
    </div>
  );
}

export function AuthFooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <p className="mt-5 text-center text-[13px] text-ink-2">
      <Link href={href} className="font-medium text-ink transition-colors hover:text-accent">{children}</Link>
    </p>
  );
}
