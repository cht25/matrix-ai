import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { Button, Card, EmptyState } from "@/components/ui";
import { timeAgo } from "@/lib/utils";
import { ConversationActions } from "@/components/conversation-actions";

export const metadata: Metadata = { title: "AI Chat" };

export default async function ChatHomePage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const { data } = await db
    .from("conversations")
    .select("id, title, updated_at, created_at, summary")
    .eq("user_id", user!.id)
    .neq("is_temporary", true)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(50);

  const conversations = (data ?? []) as { id: string; title: string; updated_at: string; created_at: string; summary: string }[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">AI Chat</h1>
          <p className="mt-1 text-slate-500">Your saved conversations — temporary chats never appear here.</p>
        </div>
        <Link href="/chat/new"><Button>+ New chat</Button></Link>
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          title="No saved conversations yet"
          body="Start a chat about a suspicious message, a security question, or anything cyber. It will be saved here."
          action={<Link href="/chat/new"><Button className="mt-2">Start your first chat</Button></Link>}
        />
      ) : (
        <div className="space-y-2.5">
          {conversations.map((c) => (
            <Card key={c.id} className="flex items-center justify-between gap-3 !p-4">
              <Link href={`/chat/${c.id}`} className="min-w-0 flex-1">
                <p className="truncate font-semibold text-slate-900 hover:text-brand-700">{c.title}</p>
                {c.summary ? <p className="mt-0.5 line-clamp-1 text-sm text-slate-500">{c.summary}</p> : null}
                <p className="mt-1 text-xs text-slate-400">Last activity {timeAgo(c.updated_at)}</p>
              </Link>
              <ConversationActions conversationId={c.id} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
