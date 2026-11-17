import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { DevicesAdmin } from "@/components/admin/devices-admin";

export const metadata: Metadata = { title: "Admin · Devices" };

export default async function AdminDevicesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Authorization happens here for rendering AND again inside every RPC the
  // client calls — hiding the nav entry is never the only control.
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (!codes.includes("security.view")) redirect("/chat");
  return (
    <AdminShell
      title="Devices"
      subtitle="Every paired device, its connection state, cross-account links and moderation history."
      role={role}
      codes={codes}
    >
      <DevicesAdmin codes={codes} />
    </AdminShell>
  );
}
