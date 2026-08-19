import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getDashboardData } from "@/lib/server/queries";
import { Badge, Card, EmptyState, Progress } from "@/components/ui";
import { formatDate, scoreLabel, timeAgo } from "@/lib/utils";

export const metadata: Metadata = { title: "Security overview" };

type Recommendation = { text: string; href: string; cta: string };

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getDashboardData(db(), user);
  const score = data.securityScore;
  const profile = data.profile as { full_name?: string; age_verified?: boolean } | null;
  const completedLessons = data.completedLessons.length;
  const certificates = data.certificates;
  const events = data.securityEvents;
  const analyses = data.analyses;
  const settings = { notifications_security_alerts: data.alertsEnabled };
  const emailConfirmed = user.emailVerified;
  const scoreInfo = scoreLabel(score);

  const recommendations: Recommendation[] = [];
  if (!emailConfirmed) recommendations.push({ text: "Verify your email address to strengthen your account.", href: "/settings?tab=account", cta: "Verify email" });
  if (profile && !profile.age_verified) recommendations.push({ text: "Complete identity (age) verification to unlock everything.", href: "/onboarding", cta: "Verify identity" });
  if (completedLessons === 0) recommendations.push({ text: "Start a course — the fastest way to raise your score.", href: "/courses", cta: "Browse courses" });
  if (!certificates || certificates.length === 0) recommendations.push({ text: "Finish a course and pass its quiz to earn a certificate.", href: "/courses", cta: "Get certified" });
  if (score < 80) recommendations.push({ text: "Turn on two-factor authentication (2FA) on your accounts.", href: "/settings?tab=security", cta: "Security settings" });
  if (settings && !settings.notifications_security_alerts) recommendations.push({ text: "Enable security alerts so you know about logins and changes.", href: "/settings?tab=notifications", cta: "Enable alerts" });
  if (recommendations.length === 0) recommendations.push({ text: "Great job — your security foundation is solid. Keep learning!", href: "/courses", cta: "Keep learning" });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow mb-1.5">Security overview</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            Hi {profile?.full_name?.split(" ")[0] ?? "there"}
          </h1>
          <p className="mt-1 text-sm text-ink-2">Your cyber safety snapshot.</p>
        </div>
        <Link href="/chat"><span className="hidden sm:inline-block"><span className="inline-flex min-h-10 items-center rounded-lg bg-ink px-4 text-sm font-medium text-bg transition-colors hover:bg-ink-2">Open MATRIX AI</span></span></Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="flex flex-col justify-between">
          <p className="text-sm font-medium text-ink-2">Cyber Safety Score</p>
          <div className="mt-2 flex items-end gap-2">
            <span className={`text-4xl font-display font-semibold ${scoreInfo.color}`}>{score}</span>
            <span className="mb-1 text-sm font-semibold text-ink-3">/100</span>
          </div>
          <Progress value={score} className="mt-3" />
          <p className="mt-2 text-xs font-semibold text-ink-3">{scoreInfo.label}</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-ink-2">Email verification</p>
          <div className="mt-2">
            {emailConfirmed ? <Badge className="border-success/30 bg-success-soft text-success">Verified ✓</Badge> : <Badge className="border-warning/30 bg-warning-soft text-warning">Not verified</Badge>}
          </div>
          <p className="mt-3 text-xs text-ink-3">Age verified: {profile?.age_verified ? "✓" : "pending"}</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-ink-2">Lessons completed</p>
          <p className="mt-2 text-4xl font-display font-semibold text-ink">{completedLessons}</p>
          <p className="mt-2 text-xs text-ink-3">Every lesson raises your score.</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-ink-2">Certificates</p>
          <p className="mt-2 text-4xl font-display font-semibold text-ink">{certificates?.length ?? 0}</p>
          <Link href="/certificates" className="mt-2 inline-block text-xs font-semibold text-accent hover:text-accent-2">View certificates →</Link>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="font-bold text-ink">Security recommendations</h2>
          <ul className="mt-3 space-y-2">
            {recommendations.map((r, i) => (
              <li key={i} className="flex items-start justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <span className="text-ink-2">{r.text}</span>
                <Link href={r.href} className="shrink-0 font-semibold text-accent hover:text-accent-2">{r.cta} →</Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-ink">Recent security events</h2>
            <Link href="/security" className="text-xs font-semibold text-accent hover:text-accent-2">View all →</Link>
          </div>
          {events && events.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {events.map((e, i) => (
                <li key={i} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                  <span className="capitalize text-ink-2">{e.event_type.replaceAll("_", " ")}</span>
                  <span className="text-xs text-ink-3">{timeAgo(e.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-3">No security events yet.</p>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-ink">Recent scam analyses</h2>
            <Link href="/scanner" className="text-xs font-semibold text-accent hover:text-accent-2">Scan something →</Link>
          </div>
          {analyses && analyses.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {analyses.map((a, i) => (
                <li key={i} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                  <span className="capitalize text-ink-2">Screenshot analysis</span>
                  <span className="flex items-center gap-2">
                    <Badge className="border-border bg-surface capitalize text-ink-2">{a.risk_level} risk</Badge>
                    <span className="text-xs text-ink-3">{timeAgo(a.created_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No analyses yet" body="Upload a suspicious screenshot and MATRIX will analyse it." />
          )}
        </Card>

        <Card>
          <h2 className="font-bold text-ink">Recent chats</h2>
          <Link href="/chat" className="text-xs font-semibold text-accent hover:text-accent-2">Open chat →</Link>
          <p className="mt-3 text-sm text-ink-3">Your latest conversations live in the sidebar — or head to the chat to continue.</p>
          {certificates && certificates.length > 0 ? (
            <div className="mt-3 border-t border-border pt-3">
              <h3 className="text-xs font-bold uppercase tracking-widest text-ink-3">Certificates</h3>
              <ul className="mt-2 space-y-1.5">
                {certificates.map((c) => (
                  <li key={c.id} className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                    <span className="font-mono text-ink-2">{c.certificate_id}</span>
                    <span className="text-xs text-ink-3">{formatDate(c.issued_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
