import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";

export const metadata = { title: "Chat" } as const;

export default async function ChatHomePage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { new: fresh } = await searchParams;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-1 flex-col">
      <ChatClient key={fresh ?? "home"} initialMessages={[]} conversationId={null} isTemporary={false} />
    </div>
  );
}
