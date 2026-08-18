"use client";

// Multi-step MATRIX registration (spec §6):
//   1 Basic information → 2 Date of birth → 3 Age verification →
//   4 Email verification → 5 Profile → 6 Complete
// Sensitive identity data is never sent to the AI.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { isValidEmail, validateAgeForRegistration, cn } from "@/lib/utils";
import { Check, Upload } from "lucide-react";
import { Alert, Button, Field, Input, Select, Spinner } from "@/components/ui";
import { AuthFooterLink, AuthShell, Divider, OAuthButtons } from "@/components/auth/login-screen";

const STEPS = ["Basic", "Date of birth", "Age verification", "Email", "Profile", "Complete"];

export function RegisterForm() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Step 1
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Step 2
  const [dob, setDob] = useState("");
  // Step 4
  const [emailVerified, setEmailVerified] = useState(false);
  const [resent, setResent] = useState(false);
  // Step 5
  const [school, setSchool] = useState("");
  const [grade, setGrade] = useState("");
  const [country, setCountry] = useState("US");

  const supabase = () => createClient();

  function go(n: number) {
    setError(null);
    setInfo(null);
    setStep(n);
  }

  async function submitBasic(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidEmail(email)) return setError("Please enter a valid email address.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    go(1);
  }

  async function submitDob(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const check = validateAgeForRegistration(dob);
    if (!check.ok) {
      const reasons: Record<string, string> = {
        DOB_MISSING: "Please enter your date of birth.",
        DOB_FUTURE: "Your date of birth can't be in the future.",
        DOB_TOO_YOUNG: "MATRIX is for users aged 11 and up.",
        DOB_TOO_OLD: "MATRIX is for users aged 17 and under.",
      };
      return setError(reasons[check.reason]);
    }
    setBusy(true);
    const { data, error } = await supabase().auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName.trim(), dob },
        emailRedirectTo: `${window.location.origin}/verify?next=/onboarding`,
      },
    });
    setBusy(false);
    if (error) return setError("We couldn't create your account. Please try again.");
    if (!data.user) return setError("We couldn't create your account. Please try again.");
    go(2);
  }

  async function uploadIdentity(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const sb = supabase();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const ext = file.type === "image/png" ? "png" : "jpg";
      const path = `${user.id}/birth-certificate-${Date.now()}.${ext}`;
      const { error: upErr } = await sb.storage.from("identity-documents").upload(path, file, { contentType: file.type });
      if (upErr) throw new Error("Upload failed. Please try again.");
      const { error: insErr } = await sb.from("identity_verifications").insert({
        user_id: user.id,
        verification_type: "birth_certificate",
        verification_reference: path,
      });
      if (insErr) throw new Error("Could not submit your document. Please try again.");
      setInfo("Document uploaded securely — it's stored privately and never sent to the AI. The security team will review it.");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkEmailVerified() {
    setBusy(true);
    const { data } = await supabase().auth.getUser();
    setEmailVerified(Boolean(data.user?.email_confirmed_at));
    setBusy(false);
  }

  async function resendEmail() {
    setBusy(true);
    const { data: { user } } = await supabase().auth.getUser();
    if (user?.email) {
      await supabase().auth.resend({ type: "signup", email: user.email, options: { emailRedirectTo: `${window.location.origin}/verify?next=/onboarding` } });
    }
    setResent(true);
    setBusy(false);
  }

  async function submitProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { data, error } = await supabase().rpc("complete_profile", {
      p_dob: dob || null,
      p_school_name: school,
      p_class_grade: grade,
      p_country: country,
    });
    setBusy(false);
    if (error) {
      const map: Record<string, string> = {
        DOB_MISSING: "Please enter your date of birth.",
        DOB_FUTURE: "Your date of birth can't be in the future.",
        DOB_TOO_YOUNG: "MATRIX is for users aged 11 and up.",
        DOB_TOO_OLD: "MATRIX is for users aged 17 and under.",
      };
      return setError(map[error.message] ?? "We couldn't save your profile. Please try again.");
    }
    const result = data as { age?: number };
    if (result.age !== undefined && (result.age < 11 || result.age > 17)) {
      return setError(`MATRIX is for users aged 11–17. (Age entered: ${result.age})`);
    }
    go(5);
  }

  function oauth(provider: "google" | "facebook") {
    const sb = supabase();
    sb.auth.signInWithOAuth({ provider, options: { redirectTo: `${window.location.origin}/verify?next=/onboarding` } });
  }

  return (
    <div>
      {/* Stepper */}
      <ol className="mb-6 flex items-center gap-1" aria-label="Registration progress">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-1 flex-col items-center gap-1.5" aria-current={i === step ? "step" : undefined}>
            <span
              className={cn(
                "grid h-7 w-7 place-items-center rounded-full border text-xs font-bold transition-colors",
                i < step ? "border-accent bg-accent text-white" : i === step ? "border-accent bg-accent-soft text-accent" : "border-border-strong text-ink-3",
              )}
            >
              {i < step ? "✓" : i + 1}
            </span>
            <span className={cn("hidden text-[10px] font-semibold uppercase tracking-wide sm:block", i === step ? "text-accent" : "text-ink-3")}>
              {label}
            </span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <form onSubmit={submitBasic} className="space-y-4" noValidate>
          <h1 className="text-lg font-bold text-ink">Create your MATRIX account</h1>
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
          <Button type="submit" className="w-full" disabled={busy}>{busy ? <Spinner /> : "Continue"}</Button>
        </form>
      )}

      {step === 1 && (
        <form onSubmit={submitDob} className="space-y-4">
          <h1 className="text-lg font-bold text-ink">When were you born?</h1>
          <Field label="Date of birth" htmlFor="dob" hint="MATRIX is for users aged 11–17. Your age is verified again server-side.">
            <Input id="dob" type="date" value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDob(e.target.value)} required />
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => go(0)}>Back</Button>
            <Button type="submit" className="flex-1" disabled={busy}>{busy ? <Spinner /> : "Create account"}</Button>
          </div>
        </form>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <h1 className="text-lg font-bold text-ink">Age verification</h1>
          <p className="text-sm text-ink-2">
            Upload a clear photo of a birth certificate or other accepted ID. It goes to a private storage
            bucket, is reviewed by the security team, and is <strong>never sent to the AI</strong>. Only a
            verification result is stored — never the document number.
          </p>
          <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-2 px-4 py-3 text-sm font-semibold text-ink transition-colors hover:border-accent">
            {busy ? <Spinner /> : <><Upload size={15} strokeWidth={1.6} /> Choose document</>}
            <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => void uploadIdentity(e)} disabled={busy} />
          </label>
          {info ? <Alert tone="success">{info}</Alert> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => go(1)}>Back</Button>
            <Button type="button" variant="outline" className="flex-1" onClick={() => go(3)}>Continue for now</Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <h1 className="text-lg font-bold text-ink">Verify your email</h1>
          <p className="text-sm text-ink-2">We sent a confirmation link to <strong>{email}</strong>. Click it, then check your status here.</p>
          {emailVerified ? <Alert tone="success">Email verified ✓</Alert> : null}
          {resent ? <Alert tone="info">Confirmation email resent — check your inbox (and spam).</Alert> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={() => go(2)}>Back</Button>
            <Button type="button" variant="outline" onClick={() => void checkEmailVerified()} disabled={busy}>
              {busy ? <Spinner /> : "I've verified — check status"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void resendEmail()} disabled={busy}>Resend email</Button>
            <Button type="button" className="flex-1" onClick={() => go(4)}>Continue</Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <form onSubmit={submitProfile} className="space-y-4">
          <h1 className="text-lg font-bold text-ink">Almost done — your profile</h1>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="School (optional)" htmlFor="school"><Input id="school" value={school} onChange={(e) => setSchool(e.target.value)} placeholder="Your school" /></Field>
            <Field label="Class / grade (optional)" htmlFor="grade"><Input id="grade" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="Grade 8" /></Field>
          </div>
          <Field label="Country" htmlFor="country">
            <Select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => go(3)}>Back</Button>
            <Button type="submit" className="flex-1" disabled={busy}>{busy ? <Spinner /> : "Finish setup"}</Button>
          </div>
        </form>
      )}

      {step === 5 && (
        <div className="space-y-4 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-success/40 text-success"><Check size={20} strokeWidth={1.6} /></div>
          <h1 className="text-lg font-bold text-ink">Welcome to MATRIX</h1>
          <p className="text-sm text-ink-2">
            Your account is ready. Head into the chat to ask your first cybersecurity question.
          </p>
          <Button className="w-full !py-3" onClick={() => router.push("/chat")}>Open MATRIX AI →</Button>
        </div>
      )}

      {step < 2 && (
        <>
          <Divider />
          <OAuthButtons onGoogle={() => oauth("google")} onFacebook={() => oauth("facebook")} />
        </>
      )}
      {step === 0 ? <AuthFooterLink href="/login">Already have an account? Sign in</AuthFooterLink> : null}
    </div>
  );
}

const COUNTRIES = [
  { id: "US", name: "United States" }, { id: "GB", name: "United Kingdom" }, { id: "AU", name: "Australia" },
  { id: "CA", name: "Canada" }, { id: "BD", name: "Bangladesh" }, { id: "IN", name: "India" },
  { id: "PK", name: "Pakistan" }, { id: "SG", name: "Singapore" }, { id: "MY", name: "Malaysia" },
  { id: "PH", name: "Philippines" }, { id: "ID", name: "Indonesia" }, { id: "NZ", name: "New Zealand" },
  { id: "IE", name: "Ireland" }, { id: "DE", name: "Germany" }, { id: "NL", name: "Netherlands" },
  { id: "AE", name: "United Arab Emirates" }, { id: "BR", name: "Brazil" }, { id: "ZA", name: "South Africa" },
  { id: "NG", name: "Nigeria" },
];
