"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical } from "lucide-react";
import { createClient } from "@/lib/supabase/browser";
import { Input } from "@/components/ui";

export function ChatHeader({ conversationId, initialTitle }: { conversationId: string; initialTitle: string }) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);

  async function save() {
    const supabase = createClient();
    await supabase.from("conversations").update({ title: title.trim() || initialTitle }).eq("id", conversationId);
    setEditing(false);
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
    a.download = `matrix-chat-${conversationId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function archive() {
    const supabase = createClient();
    await supabase.from("conversations").update({ archived_at: new Date().toISOString() }).eq("id", conversationId);
    router.push("/chat");
    router.refresh();
  }

  async function remove() {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    const supabase = createClient();
    await supabase.from("conversations").update({ deleted_at: new Date().toISOString() }).eq("id", conversationId);
    router.push("/chat");
    router.refresh();
  }

  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      {editing ? (
        <div className="flex w-full max-w-sm items-center gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Conversation title" autoFocus className="!py-2" />
          <button onClick={() => void save()} className="min-h-11 rounded-xl bg-accent px-3 text-sm font-semibold text-white hover:brightness-110">Save</button>
          <button onClick={() => { setTitle(initialTitle); setEditing(false); }} className="min-h-11 rounded-xl px-3 text-sm font-semibold text-ink-2 hover:bg-surface-2">Cancel</button>
        </div>
      ) : (
        <button onClick={() => setEditing(true)} className="group flex min-h-11 items-center gap-2 text-left" aria-label="Rename conversation">
          <h1 className="max-w-[65vw] truncate text-lg font-bold text-ink group-hover:text-accent">{title}</h1>
          <span className="text-[11px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">Rename</span>
        </button>
      )}
      <div className="relative shrink-0">
        <button
          onClick={() => setMenu(!menu)}
          aria-label="Conversation actions"
          aria-expanded={menu}
          className="grid h-10 w-10 place-items-center rounded-md text-ink-2 transition-colors hover:bg-surface-2"
        >
          <MoreVertical size={16} strokeWidth={1.6} />
        </button>
        {menu ? (
          <>
            <button className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setMenu(false)} />
            <div className="card fade-in absolute right-0 z-30 mt-1 w-44 !rounded-xl !p-1 shadow-[var(--shadow-pop)]">
              <button onClick={() => { setMenu(false); void exportJson(); }} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-surface-2">Export JSON</button>
              <button onClick={() => { setMenu(false); void archive(); }} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-surface-2">Archive</button>
              <button onClick={() => { setMenu(false); void remove(); }} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger-soft">Delete</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
