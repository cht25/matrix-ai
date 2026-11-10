import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { ContentTab } from "@/components/admin/content-tab";

export const metadata: Metadata = { title: "Admin · Scam library" };

export default async function AdminScamsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell title="Scam library" subtitle="Maintain the scam library: categories, articles and reporting resources." role={role} codes={codes}>
      <ContentTab codes={codes} />
    </AdminShell>
  );
}
