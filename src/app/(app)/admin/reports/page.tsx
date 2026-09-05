import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { ReportsTab } from "@/components/admin/reports-tab";

export const metadata: Metadata = { title: "Admin · Scam reports" };

export default async function AdminReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell title="Scam reports" subtitle="Triage scam reports submitted by learners." role={role} codes={codes}>
      <ReportsTab codes={codes} />
    </AdminShell>
  );
}
