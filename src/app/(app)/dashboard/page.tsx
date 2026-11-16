import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getDashboardData } from "@/lib/server/queries";
import { DashboardView, type DashboardRecommendation } from "@/components/dashboard/dashboard-view";

export const metadata: Metadata = { title: "Security overview" };

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

  const recommendations: DashboardRecommendation[] = [];
  if (!emailConfirmed) recommendations.push({ text: "Verify your email address to strengthen your account.", href: "/settings?tab=account", cta: "Verify email" });
  if (profile && !profile.age_verified) recommendations.push({ text: "Add identity details in your profile if you want age verification.", href: "/settings?tab=account", cta: "Edit profile" });
  if (completedLessons === 0) recommendations.push({ text: "Start a course — the fastest way to raise your score.", href: "/courses", cta: "Browse courses" });
  if (!certificates || certificates.length === 0) recommendations.push({ text: "Finish a course and pass its quiz to earn a certificate.", href: "/courses", cta: "Get certified" });
  if (score < 80) recommendations.push({ text: "Turn on two-factor authentication (2FA) on your accounts.", href: "/settings?tab=security", cta: "Security settings" });
  if (settings && !settings.notifications_security_alerts) recommendations.push({ text: "Enable security alerts so you know about logins and changes.", href: "/settings?tab=notifications", cta: "Enable alerts" });
  if (recommendations.length === 0) recommendations.push({ text: "Great job — your security foundation is solid. Keep learning!", href: "/courses", cta: "Keep learning" });

  return (
    <DashboardView
      firstName={profile?.full_name?.split(" ")[0] ?? null}
      score={score}
      emailConfirmed={emailConfirmed}
      ageVerified={profile?.age_verified === true}
      completedLessons={completedLessons}
      certificates={(certificates ?? []).map((item) => ({ id: item.id, certificate_id: item.certificate_id, issued_at: item.issued_at }))}
      events={(events ?? []).map((item) => ({ event_type: item.event_type, created_at: item.created_at }))}
      analyses={(analyses ?? []).map((item) => ({ risk_level: item.risk_level, created_at: item.created_at }))}
      recommendations={recommendations}
    />
  );
}
