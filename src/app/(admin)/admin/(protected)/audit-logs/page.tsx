import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { AuditLog } from "@/components/admin/audit-log";

export const metadata: Metadata = { title: "Admin · Audit logs" };

export default async function AdminAuditPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell title="Audit logs" subtitle="Immutable record of every administrative action taken in MATRIX." role={role} codes={codes}>
      <AuditLog codes={codes} />
    </AdminShell>
  );
}
