import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { AdminNav } from "@/components/admin/admin-nav";
import { ContentTab } from "@/components/admin/content-tab";

export const metadata: Metadata = { title: "Admin · Scam library" };

export default async function AdminScamsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = new Set<string>(await getAdminPermissions(db(), user.uid));
  if (codes.size === 0) redirect("/chat");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Scam library</h1>
      <AdminNav />
      <ContentTab codes={codes} />
    </div>
  );
}
