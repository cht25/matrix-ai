"use client";

// MATRIX authentication — premium, editorial, monochrome.
// Calligraphic brand lockup as the primary identity; restrained inputs;
// black sign-in button; OAuth as secondary actions.

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient, supabaseBrowserConfigured } from "@/lib/supabase/browser";
import { BrandLockup } from "@/components/logo";
import { Alert, Button, Field, Input, Spinner } from "@/components/ui";
import { ThemeToggle } from "@/lib/theme";
import { ServerProblem } from "@/components/server-problem";
import { failureCopy } from "@/lib/api-errors";

/** Rendered (instead of any auth form) when the deployment has no Supabase
 *  configuration — authentication honestly cannot work, so we say so. */
export function AuthUnavailable() {
  return (
    <ServerProblem
      failure={{
        ...failureCopy("not-configured"),
        detail:
          "MATRIX is not connected to its backend services yet, so authentication is unavailable. The administrator must set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY and redeploy.",
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
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-10 text-[11px] uppercase tracking-[0.18em] text-ink-3">
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

export function OAuthButtons({ onGoogle, onFacebook }: { onGoogle: () => void; onFacebook: () => void }) {
  const [busy, setBusy] = useState<"google" | "facebook" | null>(null);
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => { setBusy("google"); onGoogle(); }}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {busy === "google" ? <Spinner /> : <GoogleIcon />} Google
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => { setBusy("facebook"); onFacebook(); }}
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/chat";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<{ factorId: string; challengeId: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!supabaseBrowserConfigured) return;
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message === "Invalid login credentials" ? "Incorrect email or password." : "We couldn't sign you in. Please try again.");
      setBusy(false);
      return;
    }
    if (!data.session && data.user?.factors?.length) {
      const factorId = data.user.factors[0].id;
      const { data: cd, error: ce } = await supabase.auth.mfa.challenge({ factorId });
      if (ce || !cd) {
        setError("Could not start two-factor verification.");
        setBusy(false);
        return;
      }
      setMfa({ factorId, challengeId: cd.id });
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function handleMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfa) return;
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.mfa.verify({ factorId: mfa.factorId, challengeId: mfa.challengeId, code: mfaCode });
    if (error || !data) {
      setError("That verification code didn't work. Please try again.");
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  function oauth(provider: "google" | "facebook") {
    const supabase = createClient();
    supabase.auth.signInWithOAuth({ provider, options: { redirectTo: `${window.location.origin}/verify?next=${next}` } });
  }

  if (!supabaseBrowserConfigured) {
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
