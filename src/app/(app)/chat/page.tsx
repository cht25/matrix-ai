import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatHomePage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  return (
    <div className="mx-auto h-full max-w-3xl">
      <ChatClient initialMessages={[]} conversationId={null} isTemporary={false} />
    </div>
  );
}
