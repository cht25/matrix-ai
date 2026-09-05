import Link from "next/link";
import { db } from "@/lib/data";
import { hasAdminCode } from "@/lib/admin-rbac";
import { permissionLabel } from "@/lib/roles";
import { Card, EmptyState } from "@/components/ui";
import { SystemPulse } from "@/components/admin/system-status";

/**
 * Admin overview. Every number below is a live Firestore count for a
 * collection the caller is permitted to read — there are no placeholder or
 * illustrative figures anywhere on this dashboard.
 */
export async function OverviewTab({ codes }: { codes: string[] }) {
  const d = db();
  const count = async (fn: () => Promise<number>) => {
    try { return await fn(); } catch { return null; }
  };

  const [users, activeAdmins, reports, pendingVerification, pendingConsents, safetyEvents, auditEntries] = await Promise.all([
    hasAdminCode(codes, "users.view") ? count(() => d.collection("profiles").get().then((s) => s.size)) : null,
    hasAdminCode(codes, "users.view") ? count(() => d.collection("admin_role_assignments").get().then((s) => s.size)) : null,
    hasAdminCode(codes, "reports.view") ? count(() => d.collection("scam_reports").where("status", "==", "submitted").get().then((s) => s.size)) : null,
    hasAdminCode(codes, "verification.review") ? count(() => d.collection("identity_verifications").where("verification_status", "==", "pending_review").get().then((s) => s.size)) : null,
    hasAdminCode(codes, "consent.review") ? count(() => d.collection("guardian_consents").where("status", "==", "pending").get().then((s) => s.size)) : null,
    hasAdminCode(codes, "ai.view") ? count(() => d.collection("ai_safety_events").get().then((s) => s.size)) : null,
    hasAdminCode(codes, "audit.view") ? count(() => d.collection("audit_logs").get().then((s) => s.size)) : null,
  ]);

  const stats = [
    { label: "Registered users", value: users, href: "/admin/users", hint: "profiles" },
    { label: "Accounts with admin roles", value: activeAdmins, href: "/admin/users", hint: "role assignments" },
    { label: "New scam reports", value: reports, href: "/admin/reports", hint: "status = submitted" },
    { label: "Pending age verifications", value: pendingVerification, href: "/admin/verification", hint: "awaiting review" },
    { label: "Pending guardian consents", value: pendingConsents, href: "/admin/consents", hint: "awaiting review" },
    { label: "AI safety events", value: safetyEvents, href: "/admin/security", hint: "all time" },
    { label: "Audit entries", value: auditEntries, href: "/admin/audit-logs", hint: "all time" },
  ].filter((s) => s.value !== null || s.value === 0);

  const visibleStats = stats.filter((s) => s.value !== null);

  const pulseMetrics = [
    ...(users !== null ? [{ label: "Users", value: String(users) }] : []),
    ...(activeAdmins !== null ? [{ label: "Admins", value: String(activeAdmins) }] : []),
    ...(auditEntries !== null ? [{ label: "Audit", value: String(auditEntries) }] : []),
  ];

  return (
    <div className="space-y-5">
      <SystemPulse metrics={pulseMetrics} />

      {visibleStats.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing to show yet"
            body="Your role has no dashboard permissions. Ask a super administrator for the appropriate access."
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleStats.map((s) => (
            <Link
              key={s.label}
              href={s.href}
              className="group rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">{s.label}</p>
              <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">{s.value}</p>
              <p className="mt-1 font-mono text-[11px] text-ink-3">{s.hint}</p>
            </Link>
          ))}
        </div>
      )}

      <Card className="!p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">Your permissions</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {codes.length === 0
            ? <span className="text-sm text-ink-3">No permissions assigned.</span>
            : codes.map((c) => (
                <span key={c} className="rounded-lg border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2" title={c}>
                  {permissionLabel(c)}
                </span>
              ))}
        </div>
      </Card>
    </div>
  );
}
