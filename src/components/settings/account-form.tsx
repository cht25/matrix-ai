"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpc } from "@/lib/client/api";
import { linkOAuthProvider } from "@/lib/auth/oauth";
import { Alert, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";

type Profile = { full_name: string; email: string; phone: string; school_name: string; class_grade: string; country: string; date_of_birth: string };

export function AccountForm({ profile, countries }: { profile: Profile | null; countries: { id: string; name: string }[] }) {
  const router = useRouter();
  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [school, setSchool] = useState(profile?.school_name ?? "");
  const [grade, setGrade] = useState(profile?.class_grade ?? "");
  const [country, setCountry] = useState(profile?.country ?? "US");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await rpc("profile_update", { full_name: fullName.trim(), phone: phone.trim(), school_name: school.trim(), class_grade: grade.trim(), country });
    } catch (err) {
      setBusy(false);
      return setMsg({ tone: "danger", text: err instanceof Error && err.message ? err.message : "Could not save. Please try again." });
    }
    setBusy(false);
    setMsg({ tone: "success", text: "Saved. Note: date of birth and age verification can only be changed through verification — never directly." });
    router.refresh();
  }

  return (
    <Card>
      <h2 className="font-bold text-ink">Account details</h2>
      <p className="mt-1 text-sm text-ink-3">Email and date of birth are shown for reference and cannot be edited here for safety reasons.</p>
      <form onSubmit={save} className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" htmlFor="full-name"><Input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required /></Field>
          <Field label="Email" htmlFor="email"><Input id="email" value={profile?.email ?? ""} disabled className="bg-bg text-ink-3" /></Field>
          <Field label="Date of birth" htmlFor="dob"><Input id="dob" value={profile?.date_of_birth ?? ""} disabled className="bg-bg text-ink-3" /></Field>
          <Field label="Phone (optional)" htmlFor="phone"><Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555…" /></Field>
          <Field label="School (optional)" htmlFor="school"><Input id="school" value={school} onChange={(e) => setSchool(e.target.value)} placeholder="Your school" /></Field>
          <Field label="Class / grade" htmlFor="grade"><Input id="grade" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="Grade 8" /></Field>
        </div>
        <Field label="Country" htmlFor="country">
          <Select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
            {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
        <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Save changes"}</Button>
      </form>
      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-ink">Linked sign-in</h3>
        <p className="mt-1 text-xs text-ink-3">If Google/Facebook uses the same verified email as this account, link it here after signing in with email.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void linkOAuthProvider("google").then((r) => setMsg(r.ok ? { tone: "success", text: "Google linked." } : { tone: "danger", text: r.message || "Cancelled." }))}>Link Google</Button>
          <Button type="button" variant="outline" onClick={() => void linkOAuthProvider("facebook").then((r) => setMsg(r.ok ? { tone: "success", text: "Facebook linked." } : { tone: "danger", text: r.message || "Cancelled." }))}>Link Facebook</Button>
        </div>
      </div>
    </Card>
  );
}
