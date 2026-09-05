import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { AdminSites } from "@/components/admin/admin-sites";

export const metadata: Metadata = { title: "Admin · Sites" };

export default async function AdminSitesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell title="Published sites" subtitle="Review and moderate sites published from user workspaces." role={role} codes={codes}>
      <AdminSites />
    </AdminShell>
  );
}
