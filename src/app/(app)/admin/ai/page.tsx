import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { AiUsagePanel } from "@/components/admin/ai-usage-panel";

export const metadata: Metadata = { title: "Admin \u00b7 AI configuration" };

export default async function AdminAiPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const codes = await getAdminPermissions(db(), user.uid);
  const role = await adminRoleOf(db(), user.uid).catch(() => null);
  if (codes.length === 0) redirect("/chat");
  return (
    <AdminShell
      title="AI configuration"
      subtitle="Configure providers and models, and inspect real gateway usage."
      role={role}
      codes={codes}
    >
      <AiUsagePanel />
    </AdminShell>
  );
}
