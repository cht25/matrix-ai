import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getSecurityPageData } from "@/lib/server/queries";
import { Badge, Card, EmptyState, Progress } from "@/components/ui";
import { RevokeSessionButton } from "@/components/revoke-session-button";
import { timeAgo } from "@/lib/utils";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getSecurityPageData(db(), user);
  const events = data.events;
  const sessions = data.sessions;
  const score = data.score;
  const profile = { age_verified: data.ageVerified };
  const settings = data.settings;
  const lessonsDone = data.completedCount;
  const certCount = data.certificateCount;
  const emailVerified = user.emailVerified;

  // Derived, honest sub-scores from real signals:
  const mfaEvent = [...events].find((e) => e.event_type === "mfa_enabled" || e.event_type === "mfa_disabled");
  const mfaOn = mfaEvent ? mfaEvent.event_type === "mfa_enabled" : false;
  const changedPassword = events.some((e) => e.event_type === "password_changed" || e.event_type === "password_reset");

  const bars = [
    { label: "Password", value: Math.min(100, 40 + (emailVerified ? 25 : 0) + (changedPassword ? 20 : 0) + (mfaOn ? 15 : 0)), hint: mfaOn ? "Strong passphrase + 2FA" : "Use a unique passphrase" },
    { label: "MFA", value: mfaOn ? 100 : 10, hint: mfaOn ? "Two-factor authentication on" : "Enable MFA to lock out attackers" },
    { label: "Account protection", value: Math.min(100, 30 + (emailVerified ? 15 : 0) + (profile?.age_verified ? 15 : 0) + Math.min(25, lessonsDone * 2) + Math.min(15, certCount * 5)), hint: "Verification, learning and recovery" },
    { label: "Privacy", value: Math.min(100, 40 + (settings?.memory_enabled ? 15 : 0) + (settings?.chat_history_enabled ? 15 : 0) + (settings?.notifications_security_alerts ? 30 : 0)), hint: "Memory, history and alert controls" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Security</h1>
        <p className="mt-1 text-ink-2">Your account protection at a glance — computed server-side from real signals.</p>
      </div>

      {/* Score bars */}
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-ink">Cyber Safety Score</h2>
          <span className="text-3xl font-display font-semibold text-accent">{score}<span className="text-sm font-semibold text-ink-3">/100</span></span>
        </div>
        <div className="mt-4 space-y-4">
          {bars.map((b) => (
            <div key={b.label}>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="font-medium text-ink">{b.label}</span>
                <span className="text-xs text-ink-3">{b.value}/100 · {b.hint}</span>
              </div>
              <Progress value={b.value} />
            </div>
          ))}
        </div>
      </Card>

      {/* Recommendations */}
      <Card>
        <h2 className="font-bold text-ink">Recommendations</h2>
        <ul className="mt-3 space-y-2">
          {[
            { text: mfaOn ? "MFA is enabled — excellent." : "Enable MFA — the single most effective protection.", href: "/settings?tab=security", cta: "Set up 2FA" },
            { text: changedPassword ? "Password recently updated." : "Update your password to a fresh passphrase.", href: "/settings?tab=security", cta: "Change password" },
            { text: lessonsDone > 0 ? `${lessonsDone} lessons completed — keep going.` : "Complete the security courses to strengthen your score.", href: "/courses", cta: "Browse courses" },
            { text: sessions.length > 0 ? "Review your active sessions below." : "Sessions appear here after sign-ins.", href: "#sessions", cta: "Review sessions" },
          ].map((r, i) => (
            <li key={i} className="flex items-start justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
              <span className="text-ink-2">{r.text}</span>
              <Link href={r.href} className="shrink-0 font-semibold text-accent hover:text-accent-2">{r.cta} →</Link>
            </li>
          ))}
        </ul>
      </Card>

      {/* Sessions */}
      <Card id="sessions">
        <h2 className="font-bold text-ink">Active sessions</h2>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-ink-3">No device sessions recorded yet. They appear when you sign in.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {s.device_name || "Device"} {s.revoked_at ? <Badge className="ml-2 border-border bg-surface text-ink-3">revoked</Badge> : null}
                  </p>
                  <p className="text-xs text-ink-3">Last seen {timeAgo(s.last_seen_at)}</p>
                </div>
                {!s.revoked_at ? <RevokeSessionButton sessionId={s.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Events */}
      <Card>
        <h2 className="font-bold text-ink">Security events</h2>
        {events.length === 0 ? (
          <EmptyState title="No events yet" body="Logins, password changes and MFA updates will appear here." />
        ) : (
          <ul className="mt-3 space-y-2">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <span className="capitalize text-ink-2">{e.event_type.replaceAll("_", " ")}</span>
                <span className="text-xs text-ink-3">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
