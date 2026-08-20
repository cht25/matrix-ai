import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { AdminNav } from "@/components/admin/admin-nav";
import { UsersTab } from "@/components/admin/users-tab";

export const metadata: Metadata = { title: "Admin · Users" };

export default async function AdminUsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  if (codes.length === 0) redirect("/chat");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Users</h1>
      <AdminNav />
      <UsersTab codes={codes} />
    </div>
  );
}
