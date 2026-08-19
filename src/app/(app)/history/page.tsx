import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getHistory } from "@/lib/server/queries";
import { EmptyState } from "@/components/ui";
import { HistorySearch } from "@/components/history-search";

export const metadata: Metadata = { title: "History" };

export default async function HistoryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const conversations = await getHistory(db(), user.uid);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Chat History</h1>
          <p className="mt-1 text-ink-2">Search, archive, export or delete your saved conversations. Temporary chats never appear here.</p>
        </div>
        <Link href="/chat" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:text-accent-2">+ New chat</Link>
      </div>

      {conversations.length === 0 ? (
        <EmptyState title="Nothing here yet" body="Your saved conversations will show up here with search and export." />
      ) : (
        <HistorySearch conversations={conversations} />
      )}
    </div>
  );
}
