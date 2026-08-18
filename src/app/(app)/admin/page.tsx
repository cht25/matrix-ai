import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { AdminTabs } from "@/components/admin/admin-tabs";
import { OverviewTab } from "@/components/admin/overview-tab";
import { UsersTab } from "@/components/admin/users-tab";
import { VerificationQueue, ConsentQueue } from "@/components/admin/verification-queue";
import { ReportsTab, AiSafetyTab, AuditTab } from "@/components/admin/reports-tab";
import { ContentTab, GrantsTab } from "@/components/admin/content-tab";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "overview" } = await searchParams;
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  // Load the caller's permission codes (admin tables are RLS-gated).
  const { data: perms } = await db
    .from("admin_permissions")
    .select("code");

  // RLS on admin_permissions: only visible to admins. Empty → not an admin.
  const codes = new Set<string>((perms?.data ?? perms ?? []).map((p: { code: string }) => p.code));
  if (!demo && codes.size === 0) redirect("/dashboard");

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "users", label: "Users" },
    { id: "verification", label: "Age verification" },
    { id: "consents", label: "Consents" },
    { id: "reports", label: "Scam reports" },
    { id: "ai-safety", label: "AI safety" },
    { id: "audit", label: "Audit logs" },
    { id: "content", label: "Scam library & courses" },
    { id: "grants", label: "Privileged access" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Admin Panel</h1>
        <p className="mt-1 text-slate-500">
          Role-based access control — every section is gated by <code className="rounded bg-slate-100 px-1">has_permission()</code> in the
          database. Every sensitive action is audited.
        </p>
        {demo ? <p className="mt-1 text-xs font-semibold text-amber-600">Demo mode — showing sample data only.</p> : null}
      </div>

      <AdminTabs tabs={tabs} active={tab} codes={codes} />

      {tab === "overview" && <OverviewTab codes={codes} />}
      {tab === "users" && <UsersTab codes={codes} />}
      {tab === "verification" && <VerificationQueue codes={codes} />}
      {tab === "consents" && <ConsentQueue codes={codes} />}
      {tab === "reports" && <ReportsTab codes={codes} />}
      {tab === "ai-safety" && <AiSafetyTab codes={codes} />}
      {tab === "audit" && <AuditTab codes={codes} />}
      {tab === "content" && <ContentTab codes={codes} />}
      {tab === "grants" && <GrantsTab codes={codes} />}

      <Card className="!p-4 text-xs text-slate-400">
        Admin privacy policy: conversations are never shown by default. Any privileged access requires a
        reason, an explicit time-limited grant, and an audit entry.
      </Card>
    </div>
  );
}
