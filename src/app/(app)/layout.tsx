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

  // The sidebar must never 500 every page: any Firestore failure here is
  // logged server-side with full detail and the shell renders with an empty
  // conversation list instead (fail-closed: admin nav hidden on error).
  let sidebar: Awaited<ReturnType<typeof getSidebarData>>;
  try {
    sidebar = await getSidebarData(db(), user.uid);
  } catch (err) {
    console.error(`[MATRIX] Sidebar data failed to load for uid ${user.uid} — rendering the shell without it.`, err);
    sidebar = { conversations: [], profileName: "", profileAvatar: "", isAdmin: false };
  }
  const { conversations, profileName, profileAvatar, isAdmin } = sidebar;

  return (
    <AppShell
      user={{
        email: user.email ?? "",
        fullName: profileName || (user.email?.split("@")[0] ?? "User"),
        avatarUrl: profileAvatar,
      }}
      conversations={conversations as SidebarConversation[]}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
