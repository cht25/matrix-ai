import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { ChatClient } from "@/components/chat-client";

export const metadata = { title: "Temporary Chat" } as const;

export default async function TemporaryChatPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto h-full max-w-3xl">
      <div className="mb-4">
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Temporary Chat</h1>
        <p className="mt-1 text-sm text-ink-2">
          For questions you do not want saved. Nothing here enters your history, memory, summaries or
          search — and it's deleted after 24 hours.
        </p>
      </div>
      <ChatClient initialMessages={[]} conversationId={null} isTemporary />
    </div>
  );
}
