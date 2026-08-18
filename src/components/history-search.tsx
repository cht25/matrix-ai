"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState, Input } from "@/components/ui";
import { timeAgo } from "@/lib/utils";
import { ConversationActions } from "@/components/conversation-actions";

type Conv = { id: string; title: string; summary: string; created_at: string; updated_at: string; archived_at: string | null };

export function HistorySearch({ conversations }: { conversations: Conv[] }) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    if (!q.trim()) return conversations;
    const needle = q.toLowerCase();
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(needle) || (c.summary ?? "").toLowerCase().includes(needle),
    );
  }, [q, conversations]);

  return (
    <div className="space-y-3">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your conversations…"
        aria-label="Search conversations"
        className="max-w-md"
      />
      {filtered.length === 0 ? (
        <EmptyState title="No matches" body="Try a different search term." />
      ) : (
        <div className="space-y-2.5">
          {filtered.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <Link href={`/chat/${c.id}`} className="min-w-0 flex-1">
                <p className="truncate font-semibold text-slate-900 hover:text-brand-700">{c.title}</p>
                {c.summary ? <p className="mt-0.5 line-clamp-1 text-sm text-slate-500">{c.summary}</p> : null}
                <p className="mt-1 text-xs text-slate-400">
                  {timeAgo(c.updated_at)} · {c.archived_at ? "archived" : "active"}
                </p>
              </Link>
              <ConversationActions conversationId={c.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
