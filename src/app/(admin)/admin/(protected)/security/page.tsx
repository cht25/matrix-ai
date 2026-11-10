import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { SecurityAdmin } from "@/components/admin/security-admin";

export const metadata: Metadata = { title: "Admin · Security" };

export default async function AdminSecurityPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell title="Security" subtitle="Inspect security events, AI safety signals and privacy access grants." role={role} codes={codes}>
      <SecurityAdmin codes={codes} />
    </AdminShell>
  );
}
