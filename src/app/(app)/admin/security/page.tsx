import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { AdminNav } from "@/components/admin/admin-nav";
import { SecurityAdmin } from "@/components/admin/security-admin";

export const metadata: Metadata = { title: "Admin · Security" };

export default async function AdminSecurityPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");
  const { data: perms } = await db.from("admin_permissions").select("code");
  const codes = new Set<string>((perms?.data ?? perms ?? []).map((p: { code: string }) => p.code));
  if (!demo && codes.size === 0) redirect("/chat");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Security</h1>
      <AdminNav />
      <SecurityAdmin codes={codes} />
    </div>
  );
}
