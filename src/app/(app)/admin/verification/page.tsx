import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { AdminNav } from "@/components/admin/admin-nav";
import { VerificationQueue } from "@/components/admin/verification-queue";

export const metadata: Metadata = { title: "Admin · Age verification" };

export default async function AdminVerificationPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  if (codes.length === 0) redirect("/chat");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Age verification</h1>
      <AdminNav />
      <VerificationQueue codes={codes} />
    </div>
  );
}
