"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical, Pencil } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { Input } from "@/components/ui";

export function ChatHeader({ conversationId, initialTitle }: { conversationId: string; initialTitle: string }) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);

  async function save() {
    await rpc("conversation_update", { id: conversationId, title: title.trim() || initialTitle }).catch(() => {});
    setEditing(false);
    router.refresh();
  }

  async function exportJson() {
    const messages = await rpc<{ role: string; content: string; created_at: string }[]>("conversation_messages", { conversation_id: conversationId }).catch(() => []);
    const blob = new Blob([JSON.stringify({ conversation_id: conversationId, exported_at: new Date().toISOString(), messages }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `matrix-chat-${conversationId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function archive() {
    await rpc("conversation_update", { id: conversationId, archive: true }).catch(() => {});
    router.push("/chat");
    router.refresh();
  }

  async function remove() {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    await rpc("conversation_update", { id: conversationId, delete: true }).catch(() => {});
    router.push("/chat");
    router.refresh();
  }

  return (
    <div className="mb-2 flex shrink-0 items-center justify-between gap-2 pt-3 sm:pt-4">
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Conversation title" autoFocus className="!py-2" />
          <button type="button" onClick={() => void save()} className="min-h-11 shrink-0 rounded-[10px] bg-accent px-3.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover">Save</button>
          <button type="button" onClick={() => { setTitle(initialTitle); setEditing(false); }} className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-ink-2 hover:bg-surface-2">Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => setEditing(true)} className="group flex min-h-11 min-w-0 items-center gap-2 text-left" aria-label="Rename conversation">
          <h1 className="truncate text-base font-bold text-ink group-hover:text-accent sm:text-lg">{title}</h1>
          <Pencil size={13} strokeWidth={1.7} className="shrink-0 text-ink-3" aria-hidden="true" />
        </button>
      )}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenu(!menu)}
          aria-label="Conversation actions"
          aria-expanded={menu}
          className="grid h-11 w-11 place-items-center rounded-md text-ink-2 transition-colors hover:bg-surface-2"
        >
          <MoreVertical size={16} strokeWidth={1.6} />
        </button>
        {menu ? (
          <>
            <button type="button" className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setMenu(false)} />
            <div className="card fade-in absolute right-0 z-30 mt-1 w-44 !rounded-xl !p-1 shadow-[var(--shadow-pop)]">
              <button type="button" onClick={() => { setMenu(false); void exportJson(); }} className="block w-full rounded-lg px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-2">Export JSON</button>
              <button type="button" onClick={() => { setMenu(false); void archive(); }} className="block w-full rounded-lg px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-2">Archive</button>
              <button type="button" onClick={() => { setMenu(false); void remove(); }} className="block w-full rounded-lg px-3 py-2.5 text-left text-sm text-danger hover:bg-danger-soft">Delete</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
