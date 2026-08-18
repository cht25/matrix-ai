import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";
import { RenameConversation } from "@/components/rename-conversation";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const { data: conv } = await db.from("conversations").select("id, title, is_temporary").eq("id", id).eq("user_id", user!.id).maybeSingle();
  if (!conv) notFound();

  // Temporary chats are never opened through the normal history route.
  if (conv.is_temporary) redirect("/temporary-chat");

  const { data: messages } = await db
    .from("conversation_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <RenameConversation conversationId={id} initialTitle={conv.title} />
      </div>
      <ChatClient
        initialMessages={(messages ?? []) as { role: "user" | "assistant"; content: string }[]}
        conversationId={id}
        isTemporary={false}
      />
    </div>
  );
}
