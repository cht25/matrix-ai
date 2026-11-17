import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { EmailProviderStatus } from "@/components/admin/email-provider-status";

export const metadata: Metadata = { title: "Admin · Email provider" };

export default async function AdminEmailPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0 || !codes.includes("system.settings")) redirect("/admin");
  return (
    <AdminShell
      title="Email provider"
      subtitle="Resend dual-sender health, domain verification and delivery audit logs."
      role={role}
      codes={codes}
    >
      <EmailProviderStatus />
    </AdminShell>
  );
}
