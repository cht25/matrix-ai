"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, Trash2, Upload } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { linkOAuthProvider } from "@/lib/auth/oauth";
import { clearProfileAvatar, isAllowedAvatarFile, saveProfileAvatar } from "@/lib/client/avatar";
import { UserAvatar } from "@/components/avatar";
import { Alert, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";

type Profile = {
  full_name: string;
  email: string;
  phone: string;
  school_name: string;
  class_grade: string;
  country: string;
  date_of_birth: string;
  avatar_url?: string;
};

export function AccountForm({ profile, countries }: { profile: Profile | null; countries: { id: string; name: string }[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [school, setSchool] = useState(profile?.school_name ?? "");
  const [grade, setGrade] = useState(profile?.class_grade ?? "");
  const [country, setCountry] = useState(profile?.country ?? "US");
  const [avatar, setAvatar] = useState(profile?.avatar_url ?? "");
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await rpc("profile_update", {
        full_name: fullName.trim(),
        phone: phone.trim(),
        school_name: school.trim(),
        class_grade: grade.trim(),
        country,
      });
    } catch (err) {
      setBusy(false);
      return setMsg({ tone: "danger", text: err instanceof Error && err.message ? err.message : "Could not save. Please try again." });
    }
    setBusy(false);
    setMsg({ tone: "success", text: "Saved. Date of birth and age verification can only be changed through verification." });
    router.refresh();
  }

  async function onPickPhoto(file: File | undefined | null) {
    if (!file) return;
    const check = isAllowedAvatarFile(file);
    if (!check.ok) {
      setMsg({ tone: "danger", text: check.reason });
      return;
    }
    setPhotoBusy(true);
    setMsg(null);
    try {
      const url = await saveProfileAvatar(file);
      setAvatar(url);
      setMsg({ tone: "success", text: "Profile photo updated." });
      router.refresh();
    } catch (err) {
      setMsg({ tone: "danger", text: err instanceof Error ? err.message : "Could not upload that photo." });
    } finally {
      setPhotoBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removePhoto() {
    setPhotoBusy(true);
    setMsg(null);
    try {
      await clearProfileAvatar();
      setAvatar("");
      setMsg({ tone: "success", text: "Profile photo removed." });
      router.refresh();
    } catch {
      setMsg({ tone: "danger", text: "Could not remove the photo." });
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink">Account details</h2>
      <p className="mt-1 text-sm text-ink-2">Edit your profile here. Email is shown for reference and cannot be changed in this form.</p>

      <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative shrink-0">
          <UserAvatar src={avatar} name={fullName || profile?.email} size={80} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={photoBusy}
            aria-label="Upload a profile photo from your device"
            className="absolute -bottom-1 -right-1 grid h-9 w-9 place-items-center rounded-full border border-border bg-surface text-ink shadow-[var(--shadow-card)] transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {photoBusy ? <Spinner /> : <Camera size={14} />}
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Profile photo</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-2">Upload a picture from your device. PNG, JPEG or WebP, up to 8 MB.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={photoBusy} onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> {avatar ? "Change photo" : "Upload photo"}
            </Button>
            {avatar ? (
              <Button type="button" variant="ghost" disabled={photoBusy} onClick={() => void removePhoto()}>
                <Trash2 size={14} /> Remove
              </Button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/*"
            className="sr-only"
            onChange={(e) => void onPickPhoto(e.target.files?.[0])}
          />
        </div>
      </div>

      <form onSubmit={save} className="mt-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" htmlFor="full-name"><Input id="full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required /></Field>
          <Field label="Email" htmlFor="email"><Input id="email" value={profile?.email ?? ""} disabled className="bg-bg text-ink-3" /></Field>
          <Field label="Date of birth" htmlFor="dob" hint="Shown for reference. Change it through verification if needed.">
            <Input id="dob" value={profile?.date_of_birth ?? ""} disabled className="bg-bg text-ink-3" />
          </Field>
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
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Save changes"}</Button>
          <Link href="/onboarding" className="text-sm font-medium text-accent hover:text-accent-hover">Age verification (optional)</Link>
        </div>
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
