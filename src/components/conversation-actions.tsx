"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MoreVertical } from "lucide-react";
import { rpc } from "@/lib/client/api";

export function ConversationActions({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [menu, setMenu] = useState(false);

  async function archive() {
    await rpc("conversation_update", { id: conversationId, archive: true }).catch(() => {});
    if (pathname === `/chat/${conversationId}`) router.push("/chat");
    router.refresh();
  }
  async function remove() {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    await rpc("conversation_update", { id: conversationId, delete: true }).catch(() => {});
    if (pathname === `/chat/${conversationId}`) router.push("/chat");
    router.refresh();
  }
  async function exportJson() {
    const messages = await rpc<{ role: string; content: string; created_at: string }[]>("conversation_messages", { conversation_id: conversationId }).catch(() => []);
    const blob = new Blob([JSON.stringify({ conversation_id: conversationId, exported_at: new Date().toISOString(), messages }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `matrix-ai-chat-${conversationId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="Conversation actions"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
        className="grid h-11 w-11 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink-2"
      >
        <MoreVertical size={16} strokeWidth={1.6} />
      </button>
      {menu ? (
        <>
          <button type="button" className="fixed inset-0 z-10 cursor-default" aria-hidden="true" onClick={() => setMenu(false)} />
          <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
            <button type="button" onClick={() => { setMenu(false); void exportJson(); }} className="block w-full px-4 py-2.5 text-left text-sm text-ink-2 hover:bg-bg">Export JSON</button>
            <button type="button" onClick={() => { setMenu(false); void archive(); }} className="block w-full px-4 py-2.5 text-left text-sm text-ink-2 hover:bg-bg">Archive</button>
            <button type="button" onClick={() => { setMenu(false); void remove(); }} className="block w-full px-4 py-2.5 text-left text-sm text-danger hover:bg-danger-soft">Delete</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
