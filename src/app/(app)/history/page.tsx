import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { EmptyState } from "@/components/ui";
import { HistorySearch } from "@/components/history-search";

export const metadata: Metadata = { title: "History" };

export default async function HistoryPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  const { data } = await db
    .from("conversations")
    .select("id, title, summary, created_at, updated_at, archived_at")
    .eq("user_id", user!.id)
    .neq("is_temporary", true)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(200);

  const conversations = (data ?? []) as { id: string; title: string; summary: string; created_at: string; updated_at: string; archived_at: string | null }[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Chat History</h1>
          <p className="mt-1 text-ink-2">Search, archive, export or delete your saved conversations. Temporary chats never appear here.</p>
        </div>
        <Link href="/chat" className="text-sm font-semibold text-accent hover:text-accent-2">+ New chat</Link>
      </div>

      {conversations.length === 0 ? (
        <EmptyState title="Nothing here yet" body="Your saved conversations will show up here with search and export." />
      ) : (
        <HistorySearch conversations={conversations} />
      )}
    </div>
  );
}
