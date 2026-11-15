import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";

export const metadata = { title: "Temporary Chat" } as const;

export default async function TemporaryChatPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col">
      {/* The toolbar marks the chat as Temporary and the empty state explains it,
          so no heading takes space away from the conversation. */}
      <ChatClient initialMessages={[]} conversationId={null} isTemporary />
    </div>
  );
}
