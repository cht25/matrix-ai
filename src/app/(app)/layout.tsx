import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { AppShell } from "@/components/app-shell";
import type { SidebarConversation } from "@/lib/chat-utils";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();

  if (!user && !demo) redirect("/login");

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
    demo ? Promise.resolve({ data: true }) : db.rpc("is_admin"),
  ]);

  const conversations = (convRes.data ?? []) as SidebarConversation[];
  const profile = (profileRes.data ?? null) as { full_name: string } | null;
  const isAdmin = Boolean(adminRes.data);

  return (
    <AppShell
      user={{ email: user?.email ?? "demo@matrix.local", fullName: profile?.full_name || (user?.email?.split("@")[0] ?? "User") }}
      conversations={conversations}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
