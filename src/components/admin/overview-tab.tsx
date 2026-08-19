import { db, getCurrentUser } from "@/lib/data";
import { adminListUsers } from "@/lib/server/rpc";
import { Card } from "@/components/ui";

export async function OverviewTab({ codes }: { codes: Set<string> }) {
  const d = db();
  const sessionUser = await getCurrentUser();
  const user = { uid: sessionUser?.uid ?? "", email: sessionUser?.email ?? null, emailVerified: sessionUser?.emailVerified ?? false };

  const [users, reports, pendingVerification, pendingConsents, safetyEvents] = await Promise.all([
    codes.has("users.view") ? adminListUsers(d, user).catch(() => []) : [],
    codes.has("reports.view")
      ? d.collection("scam_reports").where("status", "==", "submitted").get().then((s) => s.docs).catch(() => [])
      : [],
    codes.has("verification.review")
      ? d.collection("identity_verifications").where("verification_status", "==", "pending_review").get().then((s) => s.docs).catch(() => [])
      : [],
    codes.has("consent.review")
      ? d.collection("guardian_consents").where("status", "==", "pending").get().then((s) => s.docs).catch(() => [])
      : [],
    codes.has("ai.view")
      ? d.collection("ai_safety_events").orderBy("created_at", "desc").limit(50).get().then((s) => s.docs).catch(() => [])
      : [],
  ]);

  const stats = [
    { label: "Registered users", value: users.length, visible: codes.has("users.view") },
    { label: "New scam reports", value: reports.length, visible: codes.has("reports.view") },
    { label: "Pending age verifications", value: pendingVerification.length, visible: codes.has("verification.review") },
    { label: "Pending consents", value: pendingConsents.length, visible: codes.has("consent.review") },
    { label: "AI safety events (last 50)", value: safetyEvents.length, visible: codes.has("ai.view") },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stats.filter((s) => s.visible).map((s) => (
        <Card key={s.label}>
          <p className="text-sm font-medium text-ink-3">{s.label}</p>
          <p className="mt-2 text-3xl font-display font-semibold text-ink">{s.value}</p>
        </Card>
      ))}
      {!stats.some((s) => s.visible) ? (
        <Card><p className="text-sm text-ink-3">Your role has no overview permissions. Ask a super admin for the appropriate role.</p></Card>
      ) : null}
      <Card>
        <p className="text-sm font-medium text-ink-3">Your permissions</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[...codes].map((c) => (
            <span key={c} className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-ink-2">{c}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}
