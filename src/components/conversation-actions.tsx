"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

export function ConversationActions({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);

  async function archive() {
    const supabase = createClient();
    await supabase.from("conversations").update({ archived_at: new Date().toISOString() }).eq("id", conversationId);
    router.refresh();
  }
  async function remove() {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    const supabase = createClient();
    await supabase.from("conversations").update({ deleted_at: new Date().toISOString() }).eq("id", conversationId);
    router.refresh();
  }
  async function exportJson() {
    const supabase = createClient();
    const { data: messages } = await supabase
      .from("conversation_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
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
        aria-label="Conversation actions"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
        className="rounded-lg px-2 py-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink-2"
      >
        ⋯
      </button>
      {menu ? (
        <>
          <button className="fixed inset-0 z-10 cursor-default" aria-hidden="true" onClick={() => setMenu(false)} />
          <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
            <button onClick={() => { setMenu(false); void exportJson(); }} className="block w-full px-4 py-2 text-left text-sm text-ink-2 hover:bg-bg">Export JSON</button>
            <button onClick={() => { setMenu(false); void archive(); }} className="block w-full px-4 py-2 text-left text-sm text-ink-2 hover:bg-bg">Archive</button>
            <button onClick={() => { setMenu(false); void remove(); }} className="block w-full px-4 py-2 text-left text-sm text-danger hover:bg-danger-soft">Delete</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
