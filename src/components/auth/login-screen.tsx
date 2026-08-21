"use client";

// MATRIX authentication — premium, editorial, monochrome.
// Calligraphic brand lockup as the primary identity; restrained inputs;
// black sign-in button; OAuth as secondary actions.

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
import { completeAuthenticatedSession, consumeOAuthRedirect, postAuthPath, signInWithOAuth } from "@/lib/auth/oauth";
import { BrandLockup } from "@/components/logo";
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
          "MATRIX is not connected to its backend services yet, so authentication is unavailable. The administrator must set the NEXT_PUBLIC_FIREBASE_* variables and redeploy.",
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
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4"><ThemeToggle compact /></div>
      <div className="mb-8"><BrandLockup /></div>
      {title ? (
        <div className="mb-7 max-w-sm text-center">
          <p className="text-lg font-medium tracking-tight text-ink">{title}</p>
          {subtitle ? <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{subtitle}</p> : null}
        </div>
      ) : null}
      <div className="card w-full max-w-sm p-6 sm:p-7">{children}</div>
      <hr className="swash-rule mt-10 w-40" />
      <p className="mt-4 text-[11px] uppercase tracking-[0.18em] text-ink-3">
        For ages 11–17 · THAMJJ13.TOP White Hat Team
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

export function OAuthButtons({ onGoogle, onFacebook }: { onGoogle: () => void | Promise<void>; onFacebook: () => void | Promise<void> }) {
  const [busy, setBusy] = useState<"google" | "facebook" | null>(null);
  async function run(which: "google" | "facebook", fn: () => void | Promise<void>) {
    setBusy(which);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => { void run("google", onGoogle); }}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {busy === "google" ? <Spinner /> : <GoogleIcon />} Google
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => { void run("facebook", onFacebook); }}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {busy === "facebook" ? <Spinner /> : <FacebookIcon />} Facebook
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
    let cancelled = false;
    (async () => {
      const result = await consumeOAuthRedirect();
      if (cancelled || !result) return;
      if (result.status === "cancelled") return;
      if (result.status === "ok") {
        setBusy(true);
        window.location.href = postAuthPath(result.onboardingComplete, next);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!firebaseBrowserConfigured) return;
    setError(null);
    setBusy(true);
    try {
      await signInWithEmailAndPassword(fbAuth(), email, password);
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

  async function oauth(provider: "google" | "facebook") {
    setError(null);
    setSessionRetry(false);
    const result = await signInWithOAuth(provider);
    if (result.status === "cancelled" || result.status === "redirecting") return;
    if (result.status === "ok") {
      window.location.href = postAuthPath(result.onboardingComplete, next);
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
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
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
      <OAuthButtons onGoogle={() => oauth("google")} onFacebook={() => oauth("facebook")} />
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
