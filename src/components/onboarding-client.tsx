"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { calculateAge } from "@/lib/utils";
import { Check, Circle, Upload } from "lucide-react";
import { Alert, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";

type Profile = { full_name: string; date_of_birth: string | null; age_verified: boolean; school_name: string; class_grade: string; country: string };
type Consent = { status: string; consent_method: string } | null;
type Verification = { verification_status: string; rejection_reason: string } | null;
type Country = { id: string; name: string; consent_required: boolean; consent_min_age: number };

export function OnboardingClient({
  profile, consent, verification, countries, emailVerified,
}: {
  profile: Profile | null;
  consent: Consent;
  verification: Verification;
  countries: Country[];
  emailVerified: boolean;
}) {
  const router = useRouter();
  const [dob, setDob] = useState(profile?.date_of_birth ?? "");
  const [school, setSchool] = useState(profile?.school_name ?? "");
  const [grade, setGrade] = useState(profile?.class_grade ?? "");
  const [country, setCountry] = useState(profile?.country ?? "US");
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [relationship, setRelationship] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  const needsDob = !profile?.date_of_birth;
  const consentStatus = consent?.status ?? "pending";
  const verificationStatus = verification?.verification_status ?? "none";
  const selectedCountry = countries.find((c) => c.id === country);
  const age = dob ? calculateAge(dob) : null;

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("complete_profile", {
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
        DOB_TOO_YOUNG: "MATRIX AI is for users aged 11 and up.",
        DOB_TOO_OLD: "MATRIX AI is for users aged 17 and under.",
      };
      setMsg({ tone: "danger", text: map[error.message] ?? error.message });
      return;
    }
    const result = data as { consent_status?: string; age?: number };
    if (result.age !== undefined && (result.age < 11 || result.age > 17)) {
      setMsg({ tone: "danger", text: `MATRIX AI is for users aged 11–17. (Age entered: ${result.age})` });
      return;
    }
    setMsg({ tone: "success", text: "Profile saved. Continue to the next steps below." });
    router.refresh();
  }

  async function submitGuardianConsent(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("submit_guardian_consent", {
      p_guardian_name: guardianName,
      p_guardian_email: guardianEmail,
      p_relationship: relationship,
    });
    setBusy(false);
    if (error) return setMsg({ tone: "danger", text: error.message });
    setMsg({ tone: "success", text: "Guardian consent submitted. A security team member will review it — you'll get a notification." });
    router.refresh();
  }

  async function uploadIdentity(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const ext = file.type === "image/png" ? "png" : "jpg";
      const path = `${user.id}/birth-certificate-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("identity-documents").upload(path, file, { contentType: file.type });
      if (upErr) throw new Error(upErr.message);
      const { error: insErr } = await supabase.from("identity_verifications").insert({
        user_id: user.id,
        verification_type: "birth_certificate",
        verification_reference: path,
      });
      if (insErr) throw new Error(insErr.message);
      setMsg({
        tone: "success",
        text: "Document uploaded securely. The raw document number is never stored in the database, sent to the AI, or logged — a security team member will review it.",
      });
      router.refresh();
    } catch (e2) {
      setMsg({ tone: "danger", text: e2 instanceof Error ? e2.message : "Upload failed." });
    } finally {
      setBusy(false);
    }
  }

  const steps = [
    { title: "Profile", done: !needsDob, body: "Set your date of birth (verified server-side), school and country." },
    { title: "Guardian consent", done: consentStatus === "approved", body: consentStatus === "pending" ? "A guardian consent is required for your country/age." : undefined },
    { title: "Age verification", done: verificationStatus === "approved" || profile?.age_verified, body: "Upload a birth certificate or ID — reviewed by a human, stored privately." },
    { title: "Email verification", done: emailVerified, body: emailVerified ? undefined : "Confirm your email address from the link we sent." },
  ];

  const allDone = steps.every((s) => s.done);

  return (
    <div className="space-y-5">
      {/* Progress steps */}
      <Card>
        <h2 className="font-bold text-ink">Your setup checklist</h2>
        <ul className="mt-3 space-y-2">
          {steps.map((s) => (
            <li key={s.title} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 text-ink-3" aria-hidden="true">{s.done ? <Check size={15} strokeWidth={1.8} /> : <Circle size={15} strokeWidth={1.4} />}</span>
              <div>
                <p className="font-medium text-ink">{s.title}</p>
                {s.body ? <p className="text-ink-3">{s.body}</p> : null}
              </div>
            </li>
          ))}
        </ul>
        {allDone ? (
          <div className="mt-4">
            <Alert tone="success">You're all set — head to your dashboard.</Alert>
            <Button className="mt-3" onClick={() => router.push("/dashboard")}>Go to dashboard →</Button>
          </div>
        ) : null}
      </Card>

      {/* Step 1: profile */}
      <Card>
        <h2 className="font-bold text-ink">1 · Your profile</h2>
        <form onSubmit={saveProfile} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date of birth" htmlFor="dob" hint={age ? `Age calculated server-side: ${age}` : "Required — validated in the database."}>
              <Input id="dob" type="date" value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDob(e.target.value)} required={needsDob} />
            </Field>
            <Field label="Country" htmlFor="country">
              <Select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
                {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="School (optional)" htmlFor="school">
              <Input id="school" value={school} onChange={(e) => setSchool(e.target.value)} />
            </Field>
            <Field label="Class / grade (optional)" htmlFor="grade">
              <Input id="grade" value={grade} onChange={(e) => setGrade(e.target.value)} />
            </Field>
          </div>
          {selectedCountry?.consent_required && age !== null && age < selectedCountry.consent_min_age ? (
            <Alert tone="warning">
              In {selectedCountry.name}, users under {selectedCountry.consent_min_age} need guardian consent — you'll provide it in the next step.
            </Alert>
          ) : null}
          <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Save profile"}</Button>
        </form>
      </Card>

      {/* Step 2: consent */}
      <Card>
        <h2 className="font-bold text-ink">2 · Guardian consent</h2>
        {consentStatus === "approved" ? (
          <Alert tone="success">Consent approved ✓</Alert>
        ) : consentStatus === "pending" && consent?.consent_method === "self" ? (
          <Alert tone="info">Self-consent confirmed at signup (you're at/above the consent age in your country).</Alert>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-2">
              Your country ({countries.find((c) => c.id === country)?.name ?? country}) requires guardian consent.
              A parent or guardian needs to provide their details; a security team member reviews them.
            </p>
            <form onSubmit={submitGuardianConsent} className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Guardian name" htmlFor="g-name"><Input id="g-name" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required /></Field>
                <Field label="Guardian email" htmlFor="g-email"><Input id="g-email" type="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} required /></Field>
              </div>
              <Field label="Relationship to you" htmlFor="g-rel">
                <Select id="g-rel" value={relationship} onChange={(e) => setRelationship(e.target.value)} required>
                  <option value="">Select…</option>
                  <option value="parent">Parent</option>
                  <option value="guardian">Legal guardian</option>
                  <option value="other">Other responsible adult</option>
                </Select>
              </Field>
              <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Submit for review"}</Button>
            </form>
          </>
        )}
      </Card>

      {/* Step 3: identity verification */}
      <Card>
        <h2 className="font-bold text-ink">3 · Age verification</h2>
        {profile?.age_verified ? (
          <Alert tone="success">Age verified ✓</Alert>
        ) : verificationStatus === "pending_review" ? (
          <Alert tone="info">Your document is being reviewed by the security team. You'll get a notification when it's approved.</Alert>
        ) : verificationStatus === "rejected" ? (
          <>
            <Alert tone="danger">Your previous submission was rejected: {verification?.rejection_reason || "no reason given"}. Please upload a clearer document.</Alert>
            <IdentityUpload onUpload={uploadIdentity} busy={busy} />
          </>
        ) : (
          <IdentityUpload onUpload={uploadIdentity} busy={busy} />
        )}
      </Card>

      {/* Step 4: email */}
      <Card>
        <h2 className="font-bold text-ink">4 · Email verification</h2>
        {emailVerified ? (
          <Alert tone="success">Email verified ✓</Alert>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-2">Check your inbox for the confirmation link. Didn't get it?</p>
            <ResendEmail />
          </>
        )}
      </Card>

      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </div>
  );
}

function IdentityUpload({ onUpload, busy }: { onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void; busy: boolean }) {
  return (
    <div className="mt-4">
      <p className="text-sm text-ink-2">
        Upload a clear photo of a birth certificate or other accepted ID (PNG/JPG, max 5 MB). It goes to a
        private storage bucket, is never exposed publicly, and is never sent to the AI.
      </p>
      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border-strong bg-surface px-4 py-2.5 text-sm font-semibold text-ink-2 hover:bg-bg">
        {busy ? <Spinner /> : <><Upload size={15} strokeWidth={1.6} /> Choose document</>}
        <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={onUpload} disabled={busy} />
      </label>
    </div>
  );
}

function ResendEmail() {
  const [sent, setSent] = useState(false);
  async function resend() {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) return;
    await supabase.auth.resend({ type: "signup", email: user.email, options: { emailRedirectTo: `${window.location.origin}/verify?next=/onboarding` } });
    setSent(true);
  }
  return sent ? <p className="mt-2 text-sm font-medium text-success">Resent ✓ check your inbox.</p> : (
    <button onClick={() => void resend()} className="mt-2 text-sm font-semibold text-accent hover:text-accent-2">Resend confirmation email</button>
  );
}
