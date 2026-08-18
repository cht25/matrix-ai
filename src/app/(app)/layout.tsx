import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { AppShell } from "@/components/app-shell";
import { ServerProblemScreen } from "@/components/server-problem";
import { isConfigured } from "@/lib/env";
import type { SidebarConversation } from "@/lib/chat-utils";

// Everything under (app) renders per-request with the real session and the
// real database — never prerendered, never static, never faked.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // No backend configured: render an honest error screen instead of loading
  // any personal data or crashing on the Supabase client.
  if (!isConfigured()) {
    return <ServerProblemScreen kind="config" />;
  }

  const db = await getDataClient();
  const user = await getCurrentUser(db);

  if (!user) redirect("/login");

  const [convRes, profileRes, adminRes] = await Promise.all([
    db.from("conversations")
      .select("id, title, summary, updated_at, is_temporary, archived_at")
      .eq("user_id", user!.id)
      .neq("is_temporary", true)
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(100),
    db.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    db.rpc("is_admin"),
  ]);

  const conversations = (convRes.data ?? []) as SidebarConversation[];
  const profile = (profileRes.data ?? null) as { full_name: string } | null;
  const isAdmin = Boolean(adminRes.data);

  return (
    <AppShell
      user={{ email: user?.email ?? "", fullName: profile?.full_name || (user?.email?.split("@")[0] ?? "User") }}
      conversations={conversations}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
