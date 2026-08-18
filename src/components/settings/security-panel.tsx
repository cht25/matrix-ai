"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Button, Card, Field, Input, Spinner } from "@/components/ui";
import { env } from "@/lib/env";

type Factor = { id: string; factor_type: string; status: string };

export function SecurityPanel() {
  const router = useRouter();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // MFA enrollment state
  const [enrolling, setEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");

  async function loadFactors() {
    const supabase = createClient();
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors((data?.all ?? []).filter((f) => f.status === "verified") as Factor[]);
  }

  useEffect(() => {
    void loadFactors();
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (password.length < 8) return setMsg({ tone: "danger", text: "Password must be at least 8 characters." });
    if (password !== confirmPassword) return setMsg({ tone: "danger", text: "Passwords do not match." });
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setMsg({ tone: "danger", text: error.message });
    } else {
      await supabase.rpc("record_security_event", { p_event_type: "password_changed", p_metadata: {} });
      setMsg({ tone: "success", text: "Password updated. A security event was recorded." });
      setPassword(""); setConfirmPassword("");
    }
    setBusy(false);
  }

  async function startEnroll() {
    setMsg(null);
    if (env.demoMode) {
      setMsg({ tone: "danger", text: "MFA is disabled in demo mode — it works with a real Supabase project." });
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    if (error || !data) return setMsg({ tone: "danger", text: error?.message ?? "Could not start MFA enrollment." });
    setQrCode(data.totp.qr_code);
    setFactorId(data.id);
    setEnrolling(true);
  }

  async function verifyEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    const supabase = createClient();
    const { data: challenge } = await supabase.auth.mfa.challenge({ factorId });
    if (!challenge) { setBusy(false); return setMsg({ tone: "danger", text: "Challenge failed." }); }
    const { data, error } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code: verifyCode });
    if (error || !data) {
      setBusy(false);
      return setMsg({ tone: "danger", text: "That code didn't match. Try again or re-scan." });
    }
    await supabase.rpc("record_security_event", { p_event_type: "mfa_enabled", p_metadata: {} });
    setMsg({ tone: "success", text: "Two-factor authentication is now enabled. Save your recovery codes from your authenticator app!" });
    setEnrolling(false); setQrCode(null); setFactorId(null); setVerifyCode("");
    await loadFactors();
    router.refresh();
    setBusy(false);
  }

  async function disableMfa(factorId: string) {
    if (!confirm("Disable two-factor authentication? Your account becomes less secure.")) return;
    const supabase = createClient();
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) return setMsg({ tone: "danger", text: error.message });
    await supabase.rpc("record_security_event", { p_event_type: "mfa_disabled", p_metadata: {} });
    setMsg({ tone: "success", text: "Two-factor authentication disabled." });
    await loadFactors();
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-bold text-ink">Change password</h2>
        <form onSubmit={changePassword} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New password" htmlFor="new-password">
              <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Field label="Confirm new password" htmlFor="confirm-password">
              <Input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            </Field>
          </div>
          <Button type="submit" disabled={busy}>{busy ? <Spinner /> : "Update password"}</Button>
        </form>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-ink">Two-factor authentication (2FA)</h2>
            <p className="mt-1 text-sm text-ink-3">
              {factors.length > 0
                ? "Enabled — your account needs a code from your authenticator app after your password."
                : "Not enabled. 2FA is the single most effective protection against account takeover."}
            </p>
          </div>
          {factors.length === 0 ? <Button onClick={() => void startEnroll()}>Enable 2FA</Button> : null}
        </div>

        {enrolling && qrCode ? (
          <div className="mt-4 rounded-xl bg-bg p-4">
            <p className="text-sm font-semibold text-ink">1. Scan this QR code with your authenticator app (e.g. Google Authenticator)</p>
            {/* The QR SVG comes from Supabase Auth and is safe to render as an image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/svg+xml;base64,${btoa(qrCode)}`} alt="QR code for authenticator app" className="mt-3 h-44 w-44 rounded-xl bg-surface p-2 shadow-sm" />
            <form onSubmit={verifyEnroll} className="mt-4 flex max-w-sm items-end gap-2">
              <Field label="2. Enter the 6-digit code" htmlFor="mfa-code">
                <Input id="mfa-code" inputMode="numeric" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="000000" required />
              </Field>
              <Button type="submit" disabled={busy}>Verify</Button>
            </form>
          </div>
        ) : null}

        {factors.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {factors.map((f) => (
              <li key={f.id} className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5 text-sm">
                <span className="text-ink-2">{f.factor_type === "totp" ? "Authenticator app (TOTP)" : f.factor_type} · verified</span>
                <button onClick={() => void disableMfa(f.id)} className="text-xs font-semibold text-red-500 hover:text-danger">Disable</button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card className="!p-4 text-sm text-ink-3">
        <p className="font-semibold text-ink-2">Active sessions &amp; login history</p>
        <p className="mt-1">See who's signed in to your account and revoke devices on the <a href="/security" className="font-semibold text-accent hover:underline">Security page</a>.</p>
      </Card>

      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </div>
  );
}
