import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";
import { isChatMode } from "@/lib/ai/modes";

export const metadata = { title: "Chat" } as const;

export default async function ChatHomePage({ searchParams }: { searchParams: Promise<{ new?: string; mode?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { new: fresh, mode: requestedMode } = await searchParams;
  const mode = isChatMode(requestedMode) ? requestedMode : "general";

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col">
      <ChatClient key={`${fresh ?? "home"}-${mode}`} initialMessages={[]} conversationId={null} isTemporary={false} initialMode={mode} />
    </div>
  );
}
