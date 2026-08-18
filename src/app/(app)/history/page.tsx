import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { EmptyState } from "@/components/ui";
import { HistorySearch } from "@/components/history-search";

export const metadata: Metadata = { title: "History" };

export default async function HistoryPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

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
          <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Chat History</h1>
          <p className="mt-1 text-slate-500">Search, archive, export or delete your saved conversations. Temporary chats never appear here.</p>
        </div>
        <Link href="/chat/new" className="text-sm font-semibold text-brand-600 hover:text-brand-700">+ New chat</Link>
      </div>

      {conversations.length === 0 ? (
        <EmptyState title="Nothing here yet" body="Your saved conversations will show up here with search and export." />
      ) : (
        <HistorySearch conversations={conversations} />
      )}
    </div>
  );
}
