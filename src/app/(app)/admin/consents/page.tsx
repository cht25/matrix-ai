import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { AdminNav } from "@/components/admin/admin-nav";
import { ConsentQueue } from "@/components/admin/verification-queue";

export const metadata: Metadata = { title: "Admin · Consents" };

export default async function AdminConsentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = new Set<string>(await getAdminPermissions(db(), user.uid));
  if (codes.size === 0) redirect("/chat");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Guardian consents</h1>
      <AdminNav />
      <ConsentQueue codes={codes} />
    </div>
  );
}
