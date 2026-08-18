import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { Badge, Card, EmptyState, Progress } from "@/components/ui";
import { formatDate, scoreLabel, timeAgo } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

type Recommendation = { text: string; href: string; cta: string };

export default async function DashboardPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const [scoreRes, profileRes, convRes, progressRes, certRes, eventsRes, analysesRes, settingsRes] = await Promise.all([
    db.rpc("security_score"),
    db.from("profiles").select("id, full_name, age_verified, email, created_at").eq("id", user!.id).maybeSingle(),
    db.from("conversations").select("id, title, updated_at").eq("user_id", user!.id).neq("is_temporary", true).order("updated_at", { ascending: false }).limit(3),
    db.from("course_progress").select("status").eq("user_id", user!.id).eq("status", "completed"),
    db.from("certificates").select("id, certificate_id, issued_at").eq("user_id", user!.id).limit(5),
    db.from("security_events").select("event_type, created_at").eq("user_id", user!.id).order("created_at", { ascending: false }).limit(5),
    db.from("security_analyses").select("risk_level, created_at").eq("user_id", user!.id).order("created_at", { ascending: false }).limit(3),
    db.from("user_security_settings").select("notifications_security_alerts").eq("user_id", user!.id).maybeSingle(),
  ]);

  const score = typeof scoreRes.data === "number" ? scoreRes.data : 0;
  const profile = profileRes.data as { full_name?: string; age_verified?: boolean; email?: string } | null;
  const completedLessons = progressRes.data?.length ?? 0;
  const certificates = certRes.data as { id: string; certificate_id: string; issued_at: string }[] | null;
  const events = eventsRes.data as { event_type: string; created_at: string }[] | null;
  const analyses = analysesRes.data as { risk_level: string; created_at: string }[] | null;
  const settings = settingsRes.data as { notifications_security_alerts?: boolean } | null;

  const scoreInfo = scoreLabel(score);

  const recommendations: Recommendation[] = [];
  if (user && !user.email_confirmed_at) recommendations.push({ text: "Verify your email address to strengthen your account.", href: "/settings?tab=account", cta: "Verify email" });
  if (profile && !profile.age_verified) recommendations.push({ text: "Complete identity (age) verification to unlock everything.", href: "/onboarding", cta: "Verify identity" });
  if (completedLessons === 0) recommendations.push({ text: "Start a course — the fastest way to raise your score.", href: "/courses", cta: "Browse courses" });
  if (!certificates || certificates.length === 0) recommendations.push({ text: "Finish a course and pass its quiz to earn a certificate.", href: "/courses", cta: "Get certified" });
  if (score < 80) recommendations.push({ text: "Turn on two-factor authentication (2FA) on your accounts.", href: "/settings?tab=security", cta: "Security settings" });
  if (settings && !settings.notifications_security_alerts) recommendations.push({ text: "Enable security alerts so you know about logins and changes.", href: "/settings?tab=notifications", cta: "Enable alerts" });
  if (recommendations.length === 0) recommendations.push({ text: "Great job — your security foundation is solid. Keep learning!", href: "/courses", cta: "Keep learning" });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
          Hi {profile?.full_name?.split(" ")[0] ?? "there"} 👋
        </h1>
        <p className="mt-1 text-slate-500">Here's your cyber safety snapshot today.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="flex flex-col justify-between">
          <p className="text-sm font-medium text-slate-500">Cyber Safety Score</p>
          <div className="mt-2 flex items-end gap-2">
            <span className={`text-4xl font-extrabold ${scoreInfo.color}`}>{score}</span>
            <span className="mb-1 text-sm font-semibold text-slate-500">/100</span>
          </div>
          <Progress value={score} className="mt-3" />
          <p className="mt-2 text-xs font-semibold text-slate-500">{scoreInfo.label}</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-slate-500">Email verification</p>
          <div className="mt-2">
            {user?.email_confirmed_at || demo ? <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">Verified ✓</Badge> : <Badge className="border-amber-200 bg-amber-50 text-amber-700">Not verified</Badge>}
          </div>
          <p className="mt-3 text-xs text-slate-400">MFA: <span className="font-medium text-slate-600">see Security page</span></p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-slate-500">Lessons completed</p>
          <p className="mt-2 text-4xl font-extrabold text-slate-900">{completedLessons}</p>
          <p className="mt-2 text-xs text-slate-400">Keep going — every lesson raises your score.</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-slate-500">Certificates</p>
          <p className="mt-2 text-4xl font-extrabold text-slate-900">{certificates?.length ?? 0}</p>
          <Link href="/certificate" className="mt-2 inline-block text-xs font-semibold text-brand-600 hover:text-brand-700">View certificates →</Link>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recommendations */}
        <Card>
          <h2 className="font-bold text-slate-900">Security recommendations</h2>
          <ul className="mt-3 space-y-2">
            {recommendations.map((r, i) => (
              <li key={i} className="flex items-start justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <span className="text-slate-700">{r.text}</span>
                <Link href={r.href} className="shrink-0 font-semibold text-brand-600 hover:text-brand-700">{r.cta} →</Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* Recent security events */}
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-900">Recent security events</h2>
            <Link href="/security" className="text-xs font-semibold text-brand-600 hover:text-brand-700">View all →</Link>
          </div>
          {events && events.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {events.map((e, i) => (
                <li key={i} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                  <span className="capitalize text-slate-700">{e.event_type.replaceAll("_", " ")}</span>
                  <span className="text-xs text-slate-400">{timeAgo(e.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No security events yet. Logins and important changes will appear here.</p>
          )}
        </Card>

        {/* Recent analyses */}
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-900">Recent scam analyses</h2>
            <Link href="/scanner" className="text-xs font-semibold text-brand-600 hover:text-brand-700">Scan something →</Link>
          </div>
          {analyses && analyses.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {analyses.map((a, i) => (
                <li key={i} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                  <span className="capitalize text-slate-700">Screenshot analysis</span>
                  <span className="flex items-center gap-2">
                    <Badge className="border-slate-200 bg-white text-slate-600 capitalize">{a.risk_level} risk</Badge>
                    <span className="text-xs text-slate-400">{timeAgo(a.created_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No analyses yet" body="Upload a suspicious screenshot and the AI scanner will analyse it." />
          )}
        </Card>

        {/* Recent conversations */}
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-900">Recent chats</h2>
            <Link href="/chat" className="text-xs font-semibold text-brand-600 hover:text-brand-700">Open chat →</Link>
          </div>
          {convRes.data && (convRes.data as unknown[]).length > 0 ? (
            <ul className="mt-3 space-y-2">
              {(convRes.data as { id: string; title: string; updated_at: string }[]).map((c) => (
                <li key={c.id}>
                  <Link href={`/chat/${c.id}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm hover:bg-slate-100">
                    <span className="truncate font-medium text-slate-700">{c.title}</span>
                    <span className="ml-3 shrink-0 text-xs text-slate-400">{timeAgo(c.updated_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No conversations yet" body="Ask the AI about a suspicious message, a password question, or anything cyber." action={
              <Link href="/chat" className="mt-2 text-sm font-semibold text-brand-600">Start chatting →</Link>
            } />
          )}
        </Card>
      </div>

      {certificates && certificates.length > 0 ? (
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-slate-900">Completed certificates</h2>
            <Link href="/certificate" className="text-xs font-semibold text-brand-600 hover:text-brand-700">View all →</Link>
          </div>
          <ul className="mt-3 space-y-2">
            {certificates.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <span className="font-mono text-slate-700">{c.certificate_id}</span>
                <span className="text-xs text-slate-400">{formatDate(c.issued_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
