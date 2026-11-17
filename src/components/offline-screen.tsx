"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CloudOff, MessageSquare, RefreshCw, Send, Trash2 } from "lucide-react";
import { QorvynaMark } from "@/components/logo";
import { Button, Card } from "@/components/ui";
import { useConnectivity } from "@/lib/client/connectivity";
import {
  listCachedConversations,
  listOutboxMessages,
  removeOutboxMessage,
  type CachedConversation,
  type OutboxItem,
} from "@/lib/client/offline-store";
import { LocalDateTimeText } from "@/components/local-time";

export function OfflineScreen() {
  const { online, reconnecting, latencyMs, retry } = useConnectivity();
  const [cachedChats, setCachedChats] = useState<CachedConversation[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [selectedChat, setSelectedChat] = useState<CachedConversation | null>(null);

  useEffect(() => {
    void listCachedConversations().then((items) => {
      setCachedChats(items);
      if (items[0]) setSelectedChat(items[0]);
    });
    void listOutboxMessages().then(setOutbox);
  }, []);

  return (
    <div className="mx-auto flex min-h-[75dvh] max-w-3xl flex-col justify-center gap-6 px-4 py-10">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-warning">
              {online ? <CheckCircle2 size={22} className="text-success" /> : <CloudOff size={22} />}
            </span>
            <div>
              <div className="flex items-center gap-2">
                <QorvynaMark compact className="h-4 w-4" />
                <span className="eyebrow">{online ? "Connection restored" : "Offline mode"}</span>
              </div>
              <h1 className="mt-1 text-xl font-semibold text-ink">
                {online ? "You are back online" : "You're offline right now"}
              </h1>
              <p className="mt-1 text-sm text-ink-2">
                {online
                  ? `Server reachable${latencyMs ? ` (${latencyMs}ms)` : ""}. Continue straight to QORVYNA Chat.`
                  : "QORVYNA cannot reach the server right now. Recent cached chats and queued drafts stored on this device remain available below."}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={online ? "outline" : "primary"} onClick={() => void retry()} disabled={reconnecting}>
              <RefreshCw size={14} className={reconnecting ? "animate-spin" : undefined} />
              {reconnecting ? "Checking…" : "Retry connection"}
            </Button>
            {online ? (
              <Link href="/chat" prefetch={false} className="btn btn-primary">
                Open QORVYNA Chat
              </Link>
            ) : null}
          </div>
        </div>
      </Card>

      {outbox.length > 0 ? (
        <Card className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Queued messages waiting for connection ({outbox.length})</h2>
          <ul className="space-y-2">
            {outbox.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface-2 p-3 text-sm">
                <div className="min-w-0">
                  <p className="text-ink">{item.text}</p>
                  <p className="mt-1 text-xs text-ink-3">
                    Saved <LocalDateTimeText value={new Date(item.createdAt).toISOString()} /> · {item.mode}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {online ? (
                    <Link href={item.conversationId ? `/chat/${item.conversationId}` : "/chat"} className="inline-flex h-8 items-center gap-1 rounded-lg bg-accent-solid px-2.5 text-xs font-medium text-accent-ink">
                      <Send size={12} /> Open chat
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Delete queued message"
                    onClick={() => {
                      void removeOutboxMessage(item.id).then(() =>
                        setOutbox((current) => current.filter((x) => x.id !== item.id)),
                      );
                    }}
                    className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Cached conversations on this device</h2>
          <span className="text-xs text-ink-3">{cachedChats.length} stored locally</span>
        </div>

        {cachedChats.length === 0 ? (
          <p className="text-sm text-ink-3">
            No cached conversations are saved in this browser yet. Open a conversation while online to keep it readable offline.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-[14rem,1fr]">
            <ul className="space-y-1">
              {cachedChats.map((chat) => (
                <li key={chat.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedChat(chat)}
                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-colors ${
                      selectedChat?.id === chat.id ? "bg-accent-soft font-semibold text-accent" : "text-ink-2 hover:bg-surface-2"
                    }`}
                  >
                    <MessageSquare size={13} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  </button>
                </li>
              ))}
            </ul>
            {selectedChat ? (
              <div className="max-h-80 space-y-2.5 overflow-y-auto rounded-xl border border-border bg-surface-2 p-3">
                {selectedChat.messages.map((msg, idx) => (
                  <div key={msg.id ?? idx} className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${msg.role === "user" ? "bg-accent-soft text-ink" : "bg-surface text-ink-2"}`}>
                    <p className="mb-0.5 font-semibold uppercase tracking-wide text-[10px] text-ink-3">{msg.role === "user" ? "You" : "QORVYNA"}</p>
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}
