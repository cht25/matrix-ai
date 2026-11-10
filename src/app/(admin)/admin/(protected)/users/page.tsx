import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { UsersTab } from "@/components/admin/users-tab";

export const metadata: Metadata = { title: "Admin · Users" };

export default async function AdminUsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell title="Users" subtitle="View accounts, change roles, suspend access. Every change is audited." role={role} codes={codes}>
      <UsersTab codes={codes} />
    </AdminShell>
  );
}
