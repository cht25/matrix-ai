import { db } from "@/lib/data";
import { hasAdminCode } from "@/lib/admin-rbac";
import { Card } from "@/components/ui";

export async function OverviewTab({ codes }: { codes: string[] }) {
  const d = db();

  const [users, reports, pendingVerification, pendingConsents, safetyEvents] = await Promise.all([
    hasAdminCode(codes, "users.view")
      ? d.collection("profiles").get().then((s) => s.size).catch(() => 0)
      : 0,
    hasAdminCode(codes, "reports.view")
      ? d.collection("scam_reports").where("status", "==", "submitted").get().then((s) => s.size).catch(() => 0)
      : 0,
    hasAdminCode(codes, "verification.review")
      ? d.collection("identity_verifications").where("verification_status", "==", "pending_review").get().then((s) => s.size).catch(() => 0)
      : 0,
    hasAdminCode(codes, "consent.review")
      ? d.collection("guardian_consents").where("status", "==", "pending").get().then((s) => s.size).catch(() => 0)
      : 0,
    hasAdminCode(codes, "ai.view")
      ? d.collection("ai_safety_events").get().then((s) => Math.min(50, s.size)).catch(() => 0)
      : 0,
  ]);

  const stats = [
    { label: "Registered users", value: users, visible: hasAdminCode(codes, "users.view") },
    { label: "New scam reports", value: reports, visible: hasAdminCode(codes, "reports.view") },
    { label: "Pending age verifications", value: pendingVerification, visible: hasAdminCode(codes, "verification.review") },
    { label: "Pending consents", value: pendingConsents, visible: hasAdminCode(codes, "consent.review") },
    { label: "AI safety events (last 50)", value: safetyEvents, visible: hasAdminCode(codes, "ai.view") },
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
          {codes.map((c) => (
            <span key={c} className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-ink-2">{c}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}
