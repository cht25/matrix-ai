"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Button, Input } from "@/components/ui";

export function RenameConversation({ conversationId, initialTitle }: { conversationId: string; initialTitle: string }) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);

  async function save() {
    const supabase = createClient();
    await supabase.from("conversations").update({ title: title.trim() || initialTitle }).eq("id", conversationId);
    setEditing(false);
    router.refresh();
  }

  if (editing) {
    return (
      <div className="flex w-full max-w-md items-center gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Conversation title" autoFocus />
        <Button onClick={() => void save()}>Save</Button>
        <Button variant="ghost" onClick={() => { setTitle(initialTitle); setEditing(false); }}>Cancel</Button>
      </div>
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="group flex items-center gap-2 text-left" aria-label="Rename conversation">
      <h1 className="max-w-[70vw] truncate text-lg font-bold text-slate-900 group-hover:text-brand-700">{title}</h1>
      <span className="text-xs text-slate-400 group-hover:text-brand-600">✏️</span>
    </button>
  );
}
