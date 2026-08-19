import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";

export const metadata = { title: "Chat" } as const;

export default async function ChatHomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto h-full max-w-3xl">
      <ChatClient initialMessages={[]} conversationId={null} isTemporary={false} />
    </div>
  );
}
