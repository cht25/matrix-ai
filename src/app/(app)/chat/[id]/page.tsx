import { redirect, notFound } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getConversation } from "@/lib/server/queries";
import { ChatClient, type ChatMessage } from "@/components/chat-client";

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
      {/* The title and the conversation's own actions live in the chat toolbar. */}
      <ChatClient
        initialMessages={data.messages as ChatMessage[]}
        conversationId={id}
        isTemporary={false}
        initialMode={data.conversation.mode}
        initialHasMore={data.hasMore}
        initialProjectId={data.conversation.active_project_id}
        initialExecutionState={data.conversation.execution_state}
        initialAgentSessionId={data.conversation.agent_session_id}
        initialTitle={data.conversation.title}
      />
    </div>
  );
}
