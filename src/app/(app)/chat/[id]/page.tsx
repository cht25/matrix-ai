import { redirect, notFound } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getConversation } from "@/lib/server/queries";
import { ChatClient, type ChatMessage } from "@/components/chat-client";
import { ChatHeader } from "@/components/chat-header";

export const metadata = { title: "Chat" } as const;

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const data = await getConversation(db(), user.uid, id);
  if (!data) notFound();
  if (data.conversation.is_temporary) redirect("/temporary-chat");

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col">
      <ChatHeader conversationId={id} initialTitle={data.conversation.title} />
      <ChatClient
        initialMessages={data.messages as ChatMessage[]}
        conversationId={id}
        isTemporary={false}
        initialMode={data.conversation.mode}
      />
    </div>
  );
}
