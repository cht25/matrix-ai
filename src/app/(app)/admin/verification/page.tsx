import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { VerificationQueue } from "@/components/admin/verification-queue";

export const metadata: Metadata = { title: "Admin · Age verification" };

export default async function AdminVerificationPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell title="Age verification" subtitle="Review age verification submissions." role={role} codes={codes}>
      <VerificationQueue codes={codes} />
    </AdminShell>
  );
}
