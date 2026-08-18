import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { AdminNav } from "@/components/admin/admin-nav";
import { OverviewTab } from "@/components/admin/overview-tab";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Admin" };

async function getPerms() {
  const db = await getDataClient();
  const { data: perms } = await db.from("admin_permissions").select("code");
  return new Set<string>((perms?.data ?? perms ?? []).map((p: { code: string }) => p.code));
}

export default async function AdminPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  const codes = await getPerms();
  if (codes.size === 0) redirect("/chat");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Admin Panel</h1>
        <p className="mt-1 text-ink-2">
          Role-based access control — every section is gated by <code className="rounded bg-surface-2 px-1">has_permission()</code> in the
          database, and every sensitive action is audited.
        </p>
      </div>
      <AdminNav />
      <OverviewTab codes={codes} />
      <Card className="!p-4 text-xs text-ink-3">
        Admin privacy policy: conversations are never shown by default. Any privileged access requires a
        reason, an explicit time-limited grant, and an audit entry.
      </Card>
    </div>
  );
}
