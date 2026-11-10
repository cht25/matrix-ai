import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { isConfigured } from "@/lib/env";
import { ServerProblemScreen } from "@/components/server-problem";
import { AdminStandaloneShell } from "@/components/admin/admin-standalone-shell";

export const dynamic = "force-dynamic";

/** Admin routes are a separate authenticated app shell, not a chat workspace tab. */
export default async function AdminAppLayout({ children }: { children: React.ReactNode }) {
  if (!isConfigured()) return <ServerProblemScreen kind="config" />;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <AdminStandaloneShell>{children}</AdminStandaloneShell>;
}
