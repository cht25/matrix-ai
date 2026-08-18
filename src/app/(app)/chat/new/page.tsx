import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";

export const metadata: Metadata = { title: "New chat" };

export default async function NewChatPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  return (
    <div className="mx-auto max-w-3xl">
      <ChatClient initialMessages={[]} conversationId={null} isTemporary={false} />
    </div>
  );
}
