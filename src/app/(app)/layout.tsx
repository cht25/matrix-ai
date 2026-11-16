import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { SESSION_COOKIE } from "@/lib/firebase/session-shared";
import { getSidebarData } from "@/lib/server/queries";
import { AppShell } from "@/components/app-shell";
import { RoboticsBackground } from "@/components/robotics-background";
import { PhoneUpdateBanner } from "@/components/phone-update-banner";
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
  if (!user) {
    const store = await cookies();
    if (store.has(SESSION_COOKIE)) {
      redirect("/api/auth/clear-session?next=/login");
    }
    redirect("/login");
  }

  // Never silently hide a profile/sidebar failure: log server-side and pass a
  // visible recoverable warning to the shell while keeping navigation usable.
  let sidebar: Awaited<ReturnType<typeof getSidebarData>>;
  let sidebarError: string | null = null;
  try {
    sidebar = await getSidebarData(db(), user.uid);
  } catch (err) {
    console.error(`[QORVYNA] Sidebar data failed to load for uid ${user.uid} — rendering the shell with warning.`, err);
    sidebar = { conversations: [], profileName: "", profileAvatar: "", isAdmin: false };
    sidebarError = "We couldn't load your profile or conversation history right now. Refresh to retry.";
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
      sidebarError={sidebarError}
    >
      <RoboticsBackground />
      <PhoneUpdateBanner />
      {children}
    </AppShell>
  );
}
