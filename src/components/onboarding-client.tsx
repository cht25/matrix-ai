"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendEmailVerification } from "firebase/auth";
import { fbAuth } from "@/lib/firebase/client";
import { rpc, RpcCallError } from "@/lib/client/api";
import { calculateAge } from "@/lib/utils";
import { Check, Circle, Eye, EyeOff } from "lucide-react";
import { Alert, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";

type Profile = { full_name: string; date_of_birth: string | null; age_verified: boolean; school_name: string; class_grade: string; country: string };
type Consent = { status: string; consent_method: string } | null;
type Verification = { verification_status: string; rejection_reason: string; verification_type?: string } | null;
type Country = { id: string; name: string; consent_required: boolean; consent_min_age: number };

const WHY_DOB =
  "MATRIX is for people aged 11–17. We ask for your date of birth so we can check that you are in that age range, apply the correct guardian-consent rules for your country, and keep adult accounts out of a youth platform.";

const WHY_CERT =
  "We ask for your birth certificate number (not a photo) so the security team can confirm you are a real person in that age range without collecting a scan of a legal document. A document image is a high-risk piece of identity data. A number can be checked and stored as a one-way hash. We never send your date of birth or certificate number to the AI. We never show the number back in chat, logs, or analytics. Only hashed data is stored. Admins see a masked reference and a verification status, not the raw number.";

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
  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [dob, setDob] = useState(profile?.date_of_birth ?? "");
  const [certNumber, setCertNumber] = useState("");
  const [showCert, setShowCert] = useState(false);
  const [school, setSchool] = useState(profile?.school_name ?? "");
  const [grade, setGrade] = useState(profile?.class_grade ?? "");
  const [country, setCountry] = useState(profile?.country ?? "BD");
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
  const identityDone = verificationStatus === "approved" || verificationStatus === "pending_review" || profile?.age_verified;

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const result = await rpc<{ consent_status?: string; age?: number }>("complete_profile", {
        dob: dob || null,
        full_name: fullName.trim() || profile?.full_name || "",
        school_name: school,
        class_grade: grade,
        country,
      });
      if (result.age !== undefined && (result.age < 11 || result.age > 17)) {
        setBusy(false);
        setMsg({ tone: "danger", text: `MATRIX AI is for users aged 11–17. (Age entered: ${result.age})` });
        return;
      }
      if (!identityDone && certNumber.trim()) {
        await rpc("submit_identity_number", { birth_certificate_number: certNumber.trim() });
        setCertNumber("");
      }
    } catch (err) {
      setBusy(false);
      const code = err instanceof RpcCallError ? err.code : "SAVE_FAILED";
      const map: Record<string, string> = {
        DOB_MISSING: "Please enter your date of birth.",
        DOB_FUTURE: "Your date of birth can't be in the future.",
        DOB_TOO_YOUNG: "MATRIX AI is for users aged 11 and up.",
        DOB_TOO_OLD: "MATRIX AI is for users aged 17 and under.",
        CERT_NUMBER_MISSING: "Please enter your birth certificate number.",
        CERT_NUMBER_INVALID: "That birth certificate number doesn't look valid. Use 6–32 letters or numbers.",
        CERT_NUMBER_IN_USE: "That birth certificate number is already linked to another account.",
        CERT_NUMBER_RATE_LIMITED: "Too many attempts today. Please try again tomorrow.",
        IDENTITY_PEPPER_NOT_CONFIGURED: "Identity verification isn't configured on this server yet. The administrator must set IDENTITY_PEPPER.",
      };
      setMsg({ tone: "danger", text: map[code] ?? code });
      return;
    }
    setBusy(false);
    setMsg({ tone: "success", text: "Saved. Continue with any remaining steps below." });
    router.refresh();
  }

  async function submitCertOnly(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await rpc("submit_identity_number", { birth_certificate_number: certNumber.trim() });
      setCertNumber("");
      setMsg({ tone: "success", text: "Birth certificate number submitted as a one-way hash. A reviewer will confirm it." });
      router.refresh();
    } catch (err) {
      const code = err instanceof RpcCallError ? err.code : "SAVE_FAILED";
      const map: Record<string, string> = {
        CERT_NUMBER_MISSING: "Please enter your birth certificate number.",
        CERT_NUMBER_INVALID: "That birth certificate number doesn't look valid. Use 6–32 letters or numbers.",
        CERT_NUMBER_IN_USE: "That birth certificate number is already linked to another account.",
        CERT_NUMBER_RATE_LIMITED: "Too many attempts today. Please try again tomorrow.",
        IDENTITY_PEPPER_NOT_CONFIGURED: "Identity verification isn't configured on this server yet. The administrator must set IDENTITY_PEPPER.",
      };
      setMsg({ tone: "danger", text: map[code] ?? code });
    } finally {
      setBusy(false);
    }
  }

  async function submitGuardianConsent(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await rpc("submit_guardian_consent", {
        guardian_name: guardianName,
        guardian_email: guardianEmail,
        relationship,
      });
    } catch (err) {
      setBusy(false);
      return setMsg({ tone: "danger", text: err instanceof RpcCallError ? err.code : "Submission failed." });
    }
    setBusy(false);
    setMsg({ tone: "success", text: "Guardian consent submitted. A security team member will review it — you'll get a notification." });
    router.refresh();
  }

  const steps = [
    { title: "Profile", done: !needsDob, body: "Date of birth, name and country — validated on the server." },
    { title: "Birth certificate number", done: Boolean(identityDone), body: identityDone ? "Submitted for review (hashed, never shown to the AI)." : "Number only — no photo." },
    { title: "Guardian consent", done: consentStatus === "approved", body: consentStatus === "pending" ? "Required for your country/age if you are under the local consent age." : undefined },
    { title: "Email verification", done: emailVerified, body: emailVerified ? undefined : "Confirm your email if your sign-in provider did not already verify it." },
  ];
  const allDone = steps.every((s) => s.done);

  return (
    <div className="space-y-5">
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

      <Card>
        <h2 className="font-bold text-ink">1 · Your profile</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{WHY_DOB}</p>
        <form onSubmit={saveProfile} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="full-name">
              <Input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </Field>
            <Field label="Date of birth" htmlFor="dob" hint={age ? `Age calculated: ${age}` : "Required — validated on the server."}>
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
          {!identityDone ? (
            <Field label="Birth certificate number" htmlFor="cert" hint="6–32 letters or numbers. Stored as a hash only.">
              <div className="relative">
                <Input
                  id="cert"
                  type={showCert ? "text" : "password"}
                  autoComplete="off"
                  value={certNumber}
                  onChange={(e) => setCertNumber(e.target.value)}
                  placeholder={country === "BD" ? "e.g. 19901234567890123" : "Certificate number"}
                  required={needsDob}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-2 text-ink-3 hover:text-ink"
                  onClick={() => setShowCert((v) => !v)}
                  aria-label={showCert ? "Hide number" : "Show number"}
                >
                  {showCert ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
          ) : null}
          <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Save profile"}</Button>
        </form>
      </Card>

      <Card>
        <h2 className="font-bold text-ink">2 · Birth certificate number</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{WHY_CERT}</p>
        {profile?.age_verified ? (
          <Alert tone="success">Age verified ✓</Alert>
        ) : verificationStatus === "pending_review" ? (
          <Alert tone="info">Your number was hashed and is waiting for a security-team review. You'll get a notification when it's approved.</Alert>
        ) : verificationStatus === "rejected" ? (
          <>
            <Alert tone="danger">Your previous submission was rejected: {verification?.rejection_reason || "no reason given"}.</Alert>
            <form onSubmit={submitCertOnly} className="mt-4 space-y-3">
              <Field label="Birth certificate number" htmlFor="cert-retry">
                <Input id="cert-retry" type={showCert ? "text" : "password"} value={certNumber} onChange={(e) => setCertNumber(e.target.value)} required />
              </Field>
              <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Resubmit number"}</Button>
            </form>
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-3">Enter the number with your profile above. No image upload is required.</p>
        )}
      </Card>

      <Card>
        <h2 className="font-bold text-ink">3 · Guardian consent</h2>
        {consentStatus === "approved" ? (
          <Alert tone="success">Consent approved ✓</Alert>
        ) : consentStatus === "pending" && consent?.consent_method === "self" ? (
          <Alert tone="info">Self-consent confirmed (you're at/above the consent age in your country).</Alert>
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

function ResendEmail() {
  const [sent, setSent] = useState(false);
  async function resend() {
    const user = fbAuth().currentUser;
    if (!user?.email) return;
    await sendEmailVerification(user, { url: `${window.location.origin}/verify?next=/settings` }).catch(() => {});
    setSent(true);
  }
  return sent ? <p className="mt-2 text-sm font-medium text-success">Resent ✓ check your inbox.</p> : (
    <button onClick={() => void resend()} className="mt-2 text-sm font-semibold text-accent hover:text-accent-2">Resend confirmation email</button>
  );
}
