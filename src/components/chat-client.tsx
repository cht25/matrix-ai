"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Button, Spinner, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { env } from "@/lib/env";

type Message = {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at?: string;
};

export function ChatClient({
  initialMessages,
  conversationId: initialConvId,
  isTemporary,
  onConversationCreated,
}: {
  initialMessages: Message[];
  conversationId: string | null;
  isTemporary: boolean;
  onConversationCreated?: (id: string) => void;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [convId, setConvId] = useState<string | null>(initialConvId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setSending(true);
    setNotice(null);

    setMessages((m) => [...m, { role: "user", content: message, created_at: new Date().toISOString() }]);

    try {
      const supabase = createClient();
      const { data, error } = await supabase.functions.invoke("ai-gateway", {
        body: { action: "chat", conversation_id: convId, is_temporary: isTemporary, message },
      });

      if (error || !data || (data as { error?: string }).error) {
        const errCode = (data as { error?: string })?.error;
        if (errCode === "RATE_LIMITED_MINUTE" || errCode === "RATE_LIMITED_DAY") {
          setNotice("You've sent a lot of messages in a short time. Take a breather and try again in a minute — your chats are safe.");
        } else {
          setNotice(
            "The AI gateway isn't reachable yet. Deploy the Supabase Edge Functions and set GROQ_API_KEY (see the README). Your message was saved to this conversation.",
          );
        }
        return;
      }

      const result = data as { reply: string; conversation_id: string; refused?: boolean; pii_redacted?: boolean };
      setMessages((m) => [...m, { role: "assistant", content: result.reply, created_at: new Date().toISOString() }]);
      if (result.pii_redacted) {
        setNotice("Personal information in your message was hidden before it reached the AI — it stays private.");
      }
      if (result.conversation_id && convId !== result.conversation_id) {
        setConvId(result.conversation_id);
        onConversationCreated?.(result.conversation_id);
        if (!isTemporary) {
          router.replace(`/chat/${result.conversation_id}`);
        }
      }
    } catch {
      setNotice("Could not reach the AI gateway. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] flex-col">
      {isTemporary ? (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
          🕒 Temporary Chat — This conversation will not be saved to your account or memory.
        </div>
      ) : null}

      <div className="no-scrollbar flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-3xl" aria-hidden="true">🛡️</p>
            <p className="mt-2 font-bold text-slate-800">Ask me anything about staying safe online</p>
            <p className="mt-1 max-w-sm text-sm text-slate-500">
              Phishing, passwords, scams, privacy, hacked accounts, suspicious messages — I only answer
              cybersecurity questions, and I'll never judge.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {["Is this email a scam?", "How do I make a strong password?", "I clicked a suspicious link — what now?"].map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); }}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={m.id ?? i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-white"
                    : "max-w-[90%] rounded-2xl rounded-bl-md border border-slate-200 bg-slate-50 px-4 py-3"
                }
              >
                {m.role === "assistant" ? <Markdown text={m.content} /> : <p className="whitespace-pre-wrap text-[15px]">{m.content}</p>}
              </div>
            </div>
          ))
        )}
        {sending ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> MATRIX AI is thinking…
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {notice ? (
        <p className="mt-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-800">{notice}</p>
      ) : null}

      <form onSubmit={send} className="mt-3 flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={env.demoMode ? "Demo mode — the AI gateway is disabled" : "Ask about phishing, passwords, scams, privacy…"}
          rows={2}
          aria-label="Message"
          disabled={sending}
          className="resize-none"
        />
        <Button type="submit" disabled={sending || !input.trim()} className="!px-5">
          {sending ? <Spinner /> : "Send"}
        </Button>
      </form>
    </div>
  );
}
