"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { isValidEmail, validateAgeForRegistration } from "@/lib/utils";
import { Alert, Button, Field, Input } from "@/components/ui";
import { AuthDivider, AuthFooterLink, OAuthButtons } from "@/components/auth-shell";

export function RegisterForm() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function handleGoogle() {
    const supabase = createClient();
    supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/verify?next=/onboarding` } });
  }
  function handleFacebook() {
    const supabase = createClient();
    supabase.auth.signInWithOAuth({ provider: "facebook", options: { redirectTo: `${window.location.origin}/verify?next=/onboarding` } });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side pre-checks; the database validates again on signup (the
    // handle_new_user trigger raises for invalid DOB, so signup fails server-side).
    if (!isValidEmail(email)) return setError("Please enter a valid email address.");
    const ageCheck = validateAgeForRegistration(dob);
    if (!ageCheck.ok) {
      const reasons: Record<string, string> = {
        DOB_MISSING: "Please enter your date of birth.",
        DOB_FUTURE: "Your date of birth can't be in the future.",
        DOB_TOO_YOUNG: "MATRIX AI is for users aged 11 and up.",
        DOB_TOO_OLD: "MATRIX AI is for users aged 17 and under.",
      };
      return setError(reasons[ageCheck.reason]);
    }
    const age = ageCheck.age;
    if (password.length < 8) return setError("Password must be at least 8 characters.");

    setBusy(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName.trim(), dob },
        emailRedirectTo: `${window.location.origin}/verify?next=/onboarding`,
      },
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    if (!data.user) {
      setError("Could not create your account. Please try again.");
      setBusy(false);
      return;
    }
    router.push("/verify?next=/onboarding");
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Full name" htmlFor="full-name">
          <Input id="full-name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" required />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label="Date of birth" htmlFor="dob" hint="You must be between 11 and 17 years old. This is verified again server-side.">
          <Input id="dob" type="date" value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDob(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters. Make it a passphrase you can remember.">
          <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Creating your account…" : "Create account"}
        </Button>
        <p className="text-xs text-slate-500">
          By creating an account you confirm you are aged 11–17. Parental/guardian consent is required in
          some countries and will be collected during onboarding.
        </p>
      </form>

      <AuthDivider />
      <OAuthButtons onGoogle={handleGoogle} onFacebook={handleFacebook} />
      <AuthFooterLink href="/login">Already have an account? Sign in</AuthFooterLink>
    </div>
  );
}
