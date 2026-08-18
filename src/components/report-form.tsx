"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";

export function ReportForm({ categories, countries }: { categories: { id: string; name: string }[]; countries: { id: string; name: string }[] }) {
  const router = useRouter();
  const [category, setCategory] = useState("");
  const [platform, setPlatform] = useState("");
  const [description, setDescription] = useState("");
  const [moneyLost, setMoneyLost] = useState("");
  const [accountCompromised, setAccountCompromised] = useState(false);
  const [infoShared, setInfoShared] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const [country, setCountry] = useState("US");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (description.trim().length < 20) return setError("Please describe what happened in at least a few sentences.");
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError("Not signed in."); setBusy(false); return; }

    const { error: insErr } = await supabase.from("scam_reports").insert({
      user_id: user.id,
      category_id: category || null,
      platform: platform.trim(),
      description: description.trim(),
      money_lost: parseFloat(moneyLost) || 0,
      account_compromised: accountCompromised,
      personal_information_shared: infoShared,
      evidence_available: evidence,
      country,
    });
    setBusy(false);
    if (insErr) return setError(insErr.message);
    setDone(true);
  }

  if (done) {
    return (
      <Alert tone="success">
        <strong>Report submitted — thank you for helping keep everyone safer.</strong>
        <p className="mt-1">Your report is private. The support team may follow up. You can also report to an official organisation using the resources below.</p>
        <button onClick={() => { router.push("/dashboard"); router.refresh(); }} className="mt-2 font-semibold text-emerald-800 underline">Go to dashboard →</button>
      </Alert>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Scam type" htmlFor="category">
          <Select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Not sure — help me pick</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Where did it happen?" htmlFor="platform">
          <Input id="platform" value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="e.g. WhatsApp, Instagram, email, a website" />
        </Field>
      </div>

      <Field label="What happened?" htmlFor="description">
        <Textarea id="description" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the scam: who contacted you, what they said, what they asked for… (do not include passwords or codes)" required />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Money lost (if any)" htmlFor="money">
          <Input id="money" type="number" min="0" step="0.01" value={moneyLost} onChange={(e) => setMoneyLost(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Your country" htmlFor="country">
          <Select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
            {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">What was affected?</legend>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={accountCompromised} onChange={(e) => setAccountCompromised(e.target.checked)} /> An account was taken over
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={infoShared} onChange={(e) => setInfoShared(e.target.checked)} /> Personal information was shared
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={evidence} onChange={(e) => setEvidence(e.target.checked)} /> I have evidence (screenshots, messages)
        </label>
      </fieldset>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" disabled={busy} className="w-full">{busy ? "Submitting…" : "Submit private report"}</Button>
    </form>
  );
}
