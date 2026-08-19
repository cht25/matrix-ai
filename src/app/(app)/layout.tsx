import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getSidebarData } from "@/lib/server/queries";
import { AppShell } from "@/components/app-shell";
import { ServerProblemScreen } from "@/components/server-problem";
import { isConfigured } from "@/lib/env";
import type { SidebarConversation } from "@/lib/chat-utils";

// Everything under (app) renders per-request with the real session and the
// real database — never prerendered, never static, never faked.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // No backend configured: render an honest error screen instead of loading
  // any personal data or crashing on the Firebase client.
  if (!isConfigured()) {
    return <ServerProblemScreen kind="config" />;
  }

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { conversations, profileName, isAdmin } = await getSidebarData(db(), user.uid);

  return (
    <AppShell
      user={{ email: user.email ?? "", fullName: profileName || (user.email?.split("@")[0] ?? "User") }}
      conversations={conversations as SidebarConversation[]}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
