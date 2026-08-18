import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { AdminNav } from "@/components/admin/admin-nav";
import { AuditTab } from "@/components/admin/reports-tab";

export const metadata: Metadata = { title: "Admin · Audit logs" };

export default async function AdminAuditPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");
  const { data: perms } = await db.from("admin_permissions").select("code");
  const codes = new Set<string>((perms?.data ?? perms ?? []).map((p: { code: string }) => p.code));
  if (codes.size === 0) redirect("/chat");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Audit logs</h1>
      <AdminNav />
      <AuditTab codes={codes} />
    </div>
  );
}
