import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { AiConfigTabs } from "@/components/admin/ai-config-tabs";

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
      subtitle="Text models, image generation, agent providers and API keys — with live health checks."
      role={role}
      codes={codes}
    >
      <AiConfigTabs />
    </AdminShell>
  );
}
