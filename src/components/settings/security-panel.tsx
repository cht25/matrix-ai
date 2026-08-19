"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { multiFactor, updatePassword, reload, type MultiFactorUser, type TotpSecret } from "firebase/auth";
import { TotpMultiFactorGenerator } from "firebase/auth";
import QRCode from "qrcode";
import { fbAuth } from "@/lib/firebase/client";
import { rpc } from "@/lib/client/api";
import { Alert, Button, Card, Field, Input, Spinner } from "@/components/ui";

type Factor = { uid: string; factorId: "totp" | "phone"; displayName?: string };

export function SecurityPanel() {
  const router = useRouter();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [pendingSecret, setPendingSecret] = useState<TotpSecret | null>(null);
  const [verifyCode, setVerifyCode] = useState("");

  function mfaUser(): MultiFactorUser | null {
    const user = fbAuth().currentUser;
    return user ? multiFactor(user) : null;
  }

  async function loadFactors() {
    const user = fbAuth().currentUser;
    if (!user) return;
    await reload(user).catch(() => {});
    setFactors(
      multiFactor(user).enrolledFactors
        .filter((f) => f.factorId === "totp")
        .map((f) => ({ uid: f.uid, factorId: "totp" as const, displayName: f.displayName ?? undefined })),
    );
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
    const user = fbAuth().currentUser;
    if (!user) {
      setBusy(false);
      return setMsg({ tone: "danger", text: "Please sign in again first." });
    }
    try {
      await updatePassword(user, password);
      await rpc("record_security_event", { event_type: "password_changed", metadata: {} }).catch(() => {});
      setMsg({ tone: "success", text: "Password updated. A security event was recorded." });
      setPassword(""); setConfirmPassword("");
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/requires-recent-login") {
        setMsg({ tone: "danger", text: "For safety, sign out and sign back in, then change your password." });
      } else if (code === "auth/weak-password") {
        setMsg({ tone: "danger", text: "That password is too weak. Use at least 8 characters." });
      } else {
        setMsg({ tone: "danger", text: "Password update failed. Please try again." });
      }
    }
    setBusy(false);
  }

  async function startEnroll() {
    setMsg(null);
    const user = fbAuth().currentUser;
    if (!user?.email) return setMsg({ tone: "danger", text: "Please sign in again first." });
    try {
      const session = await multiFactor(user).getSession();
      const totpAssertion = await TotpMultiFactorGenerator.generateSecret(session);
      const url = totpAssertion.generateQrCodeUrl(user.email, "MATRIX AI");
      const dataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      setQrCode(dataUrl);
      setPendingSecret(totpAssertion);
      setEnrolling(true);
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      const text =
        code === "auth/requires-recent-login"
          ? "For safety, sign out and sign back in before enabling 2FA."
          : code === "auth/operation-not-allowed"
            ? "TOTP two-factor is not enabled in Firebase yet (Authentication → Sign-in method → Phone? no — enable ‘Multi-factor (TOTP)’)."
            : "Could not start MFA enrollment.";
      setMsg({ tone: "danger", text });
    }
  }

  async function verifyEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingSecret) return;
    setBusy(true);
    try {
      const cred = TotpMultiFactorGenerator.assertionForEnrollment(pendingSecret, verifyCode.trim());
      const mfa = mfaUser();
      if (!mfa) throw new Error("no user");
      await mfa.enroll(cred, "Authenticator app");
      await rpc("record_security_event", { event_type: "mfa_enabled", metadata: {} }).catch(() => {});
      setMsg({ tone: "success", text: "Two-factor authentication is now enabled. Save your recovery codes from your authenticator app!" });
      setEnrolling(false); setQrCode(null); setPendingSecret(null); setVerifyCode("");
      await loadFactors();
      router.refresh();
    } catch {
      setMsg({ tone: "danger", text: "That code didn't match. Try again or re-scan." });
    }
    setBusy(false);
  }

  async function disableMfa(factorUid: string) {
    if (!confirm("Disable two-factor authentication? Your account becomes less secure.")) return;
    const mfa = mfaUser();
    if (!mfa) return;
    try {
      await mfa.unenroll(factorUid);
      await rpc("record_security_event", { event_type: "mfa_disabled", metadata: {} }).catch(() => {});
      setMsg({ tone: "success", text: "Two-factor authentication disabled." });
      await loadFactors();
      router.refresh();
    } catch {
      setMsg({ tone: "danger", text: "Could not disable 2FA. Please try again." });
    }
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
            {/* Data URL generated locally from the TOTP secret — never leaves the device */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrCode} alt="QR code for authenticator app" className="mt-3 h-44 w-44 rounded-xl bg-surface p-2 shadow-sm" />
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
              <li key={f.uid} className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5 text-sm">
                <span className="text-ink-2">{f.factorId === "totp" ? "Authenticator app (TOTP)" : f.factorId} · verified</span>
                <button onClick={() => void disableMfa(f.uid)} className="text-xs font-semibold text-red-500 hover:text-danger">Disable</button>
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
