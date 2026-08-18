"use client";

// MATRIX chat experience (spec §10–§13, §42):
// streaming responses, stop generating, retry/regenerate, copy, timestamps,
// image attachment → screenshot analysis, temporary chat, empty-state cards,
// error recovery. The AI gateway is the only path to Groq.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Button, Spinner, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { MatrixMark } from "@/components/logo";
import { useToast } from "@/components/toast";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

type Message = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

const SUGGESTIONS = [
  { icon: "🔐", label: "Check my account security", prompt: "How can I check my account security and lock things down?" },
  { icon: "🎣", label: "Is this message phishing?", prompt: "Is this message phishing? It says I won a prize and must pay a fee to receive it." },
  { icon: "🛡️", label: "How do I secure my account?", prompt: "How do I secure my account? What should I do first?" },
  { icon: "📱", label: "Analyze this screenshot", prompt: null, href: "/scanner" },
  { icon: "🚨", label: "I think I've been scammed", prompt: "I think I've been scammed. What should I do now?" },
  { icon: "🎓", label: "Teach me cybersecurity", prompt: "Teach me the basics of cybersecurity — where should I start?" },
];

// --- Demo-mode canned replies (clearly badged preview, no real AI) -------------
function demoReply(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("phish") || m.includes("scam") || m.includes("prize")) {
    return "**Risk: High**\n\n**What I noticed:** This matches a classic prize/lottery scam pattern — you never entered a contest, and the \"winner\" must pay a fee.\n\n**Why it matters:** Real prizes never ask winners to pay. Scammers use the fee to take money or card details.\n\n**What to do now:** Don't reply, don't pay, and don't click any links. Tell a trusted adult.\n\n**Reporting options:** You can report it to the FTC at reportfraud.ftc.gov.\n\n_⚠️ Demo preview — real analysis runs when the AI gateway is deployed with GROQ_API_KEY._";
  }
  if (m.includes("password") || m.includes("secure")) {
    return "**Simple explanation:** Use a passphrase — 3 or 4 random words joined together, at least 12 characters.\n\n**Example:** `purple-lantern-cloud-42`\n\n**Safe practice:** Use a different passphrase for every account and turn on two-factor authentication.\n\n**Common mistake:** Reusing the same password everywhere — when one site leaks it, scammers try it on all your other accounts.\n\n_⚠️ Demo preview — real analysis runs when the AI gateway is deployed with GROQ_API_KEY._";
  }
  if (m.includes("scammed") || m.includes("hacked") || m.includes("help")) {
    return "I'm sorry that happened — you're not in trouble, and you're not alone.\n\n**What to do now:**\n1. Tell a trusted adult immediately.\n2. Change the affected passwords from a different device.\n3. Turn on two-factor authentication.\n4. Keep evidence (screenshots).\n5. Report it using the verified reporting resources in the Scam Library.\n\n_⚠️ Demo preview — real analysis runs when the AI gateway is deployed with GROQ_API_KEY._";
  }
  return "That's a great cybersecurity question.\n\n**Simple explanation:** Staying safe online is about layers: strong unique passwords, two-factor authentication, cautious clicking, and knowing how to spot social engineering.\n\n**Safe practice:** Start with your email account — give it the strongest passphrase and enable 2FA.\n\n**Common mistake:** Trusting urgent messages. When something feels rushed, pause before clicking.\n\n_⚠️ Demo preview — real analysis runs when the AI gateway is deployed with GROQ_API_KEY._";
}

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
  const toast = useToast();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [convId, setConvId] = useState<string | null>(initialConvId);
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamedText, streaming, scrollToBottom]);

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  async function requestToken(): Promise<string | null> {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  // --- Streaming request -------------------------------------------------------
  async function streamMessage(message: string, replaceLastAssistant = false) {
    setError(null);
    setNotice(null);
    setStreaming(true);
    setLastUserMessage(message);
    setRegenerating(replaceLastAssistant);
    setStreamedText("");

    const supabase = createClient();
    const token = await requestToken();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (env.demoMode) {
        // Simulated streaming preview (demo mode only).
        const reply = demoReply(message);
        for (let i = 0; i < reply.length; i += 3) {
          if (controller.signal.aborted) break;
          setStreamedText(reply.slice(0, i + 3));
          await new Promise((r) => setTimeout(r, 14));
        }
        setStreamedText(reply);
        setMessages((m) => {
          const base = replaceLastAssistant ? m.slice(0, -1) : m;
          return [...base, { role: "assistant", content: reply, created_at: new Date().toISOString() }];
        });
        setStreamedText(null);
        return;
      }

      const res = await fetch(`${env.supabaseUrl}/functions/v1/ai-gateway`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: env.supabaseAnonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "chat", stream: true, conversation_id: convId, is_temporary: isTemporary, message }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (data.error === "AI_GATEWAY_NOT_CONFIGURED") {
          setError("The AI gateway isn't configured yet. Deploy the edge functions and set GROQ_API_KEY (see the README).");
        } else if (data.error === "RATE_LIMITED_MINUTE" || data.error === "RATE_LIMITED_DAY") {
          setError("You've sent a lot of messages in a short time. Take a breather and try again in a minute.");
        } else {
          setError("We couldn't reach MATRIX AI. Please try again.");
        }
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        // Non-streaming JSON (refusals, etc.)
        const data = (await res.json()) as { reply?: string; conversation_id?: string; refused?: boolean };
        if (data.reply) {
          const reply = data.reply;
          setMessages((m) => [...m, { role: "assistant", content: reply, created_at: new Date().toISOString() }]);
          if (data.conversation_id && convId !== data.conversation_id) {
            setConvId(data.conversation_id);
            onConversationCreated?.(data.conversation_id);
            if (!isTemporary) router.replace(`/chat/${data.conversation_id}`);
          }
        }
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("no stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let finalReply: string = "";
      let gotConversationId: string | null = null;
      let streamError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.trim();
          if (!line.startsWith("data:")) continue;
          try {
            const data = JSON.parse(line.slice(5).trim()) as {
              delta?: string; done?: boolean; conversation_id?: string; error?: string;
            };
            if (typeof data.delta === "string") {
              finalReply += data.delta;
              setStreamedText(finalReply);
            }
            if (data.conversation_id) gotConversationId = data.conversation_id;
            if (data.error) streamError = data.error;
            if (data.done) {
              setMessages((m) => {
                const base = replaceLastAssistant ? m.slice(0, -1) : m;
                return [...base, { role: "assistant", content: finalReply, created_at: new Date().toISOString() }];
              });
            }
          } catch {
            // malformed event — skip
          }
        }
      }

      if (streamError) {
        setError("The response was interrupted. Your message is safe — try again.");
        return;
      }
      if (gotConversationId && convId !== gotConversationId) {
        setConvId(gotConversationId);
        onConversationCreated?.(gotConversationId);
        if (!isTemporary) router.replace(`/chat/${gotConversationId}`);
      }
    } catch {
      if (!controller.signal.aborted) {
        setError("We couldn't reach MATRIX AI. Check your connection and try again.");
      } else {
        setNotice("Generation stopped. Your message is saved.");
      }
    } finally {
      setStreaming(false);
      setStreamedText(null);
      setRegenerating(false);
      abortRef.current = null;
    }
  }

  async function send(e?: React.FormEvent, messageOverride?: string) {
    e?.preventDefault();
    const message = (messageOverride ?? input).trim();
    if (!message || streaming) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message, created_at: new Date().toISOString() }]);
    await streamMessage(message);
  }

  function regenerate() {
    if (!lastUserMessage || streaming) return;
    void streamMessage(lastUserMessage, true);
  }

  function retry() {
    if (!lastUserMessage || streaming) return;
    setError(null);
    // Re-attach the user message bubble if the previous attempt failed before
    // streaming (streamMessage appends the user bubble only via send()).
    const hasUser = messages.some((m) => m.role === "user" && m.content === lastUserMessage);
    if (!hasUser) {
      setMessages((m) => [...m, { role: "user", content: lastUserMessage, created_at: new Date().toISOString() }]);
    }
    void streamMessage(lastUserMessage, false);
  }

  // --- Attachment → screenshot analysis -----------------------------------------
  async function handleFile(file: File | undefined | null) {
    if (!file || streaming) return;
    setError(null);
    const okTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!file || !okTypes.includes(file.type)) return setError("Only PNG, JPEG and WebP images can be analysed.");
    if (file.size > 8 * 1024 * 1024) return setError("File is too large (max 8 MB).");

    setMessages((m) => [...m, { role: "user", content: `📎 Screenshot: ${file.name}`, created_at: new Date().toISOString() }]);
    setStreaming(true);
    setStreamedText("Analysing your screenshot…");
    try {
      const supabase = createClient();
      if (env.demoMode) {
        await new Promise((r) => setTimeout(r, 900));
        const reply = "**Risk: High**  \n**Confidence: 85%**  \n\n**What I noticed:** Classic scam markers — urgency, a request for a one-time code, and a lookalike sender address.\n\n**What to do now:** Don't reply or click. Tell a trusted adult and report it.\n\n_⚠️ Demo preview — real analysis runs when the AI gateway is deployed with GROQ_API_KEY._";
        setMessages((m) => [...m, { role: "assistant", content: reply, created_at: new Date().toISOString() }]);
        return;
      }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("no user");
      const ext = file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1];
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("security-screenshots").upload(path, file, { contentType: file.type });
      if (upErr) throw new Error(upErr.message);
      const { data, error: invErr } = await supabase.functions.invoke("ai-gateway", { body: { action: "scan", storage_path: path } });
      if (invErr || (data as { error?: string })?.error) throw new Error("scan failed");
      const result = data as { reply: string };
      setMessages((m) => [...m, { role: "assistant", content: result.reply, created_at: new Date().toISOString() }]);
    } catch {
      setError("We couldn't analyse that screenshot. Please try again.");
    } finally {
      setStreaming(false);
      setStreamedText(null);
    }
  }

  function copyMessage(text: string) {
    navigator.clipboard?.writeText(text).then(() => toast("Copied to clipboard")).catch(() => {});
  }

  return (
    <div className="flex h-[calc(100dvh-10.5rem)] flex-col lg:h-[calc(100dvh-8rem)]">
      {isTemporary ? (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm font-medium text-warning">
          🕒 Temporary Chat — This conversation will not be saved to your account or memory.
        </div>
      ) : null}

      {/* Messages */}
      <div className="no-scrollbar flex-1 space-y-5 overflow-y-auto rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur-sm sm:p-6">
        {messages.length === 0 && !streaming ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <MatrixMark className="mb-4 h-12 w-12" />
            <h1 className="text-xl font-extrabold tracking-tight text-ink sm:text-2xl">
              How can MATRIX protect you today?
            </h1>
            <p className="mt-2 max-w-md text-sm text-ink-2">
              Your AI Cyber Safety Assistant. Ask about phishing, passwords, scams, privacy — I only answer
              cybersecurity questions, and I never judge.
            </p>
            <div className="mt-6 grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => {
                    if (s.href) {
                      router.push(s.href);
                    } else if (s.prompt) {
                      void send(undefined, s.prompt);
                    }
                  }}
                  className="card card-hover flex min-h-14 items-center gap-3 px-4 py-3 text-left text-sm font-medium text-ink hover:border-accent"
                >
                  <span className="text-lg" aria-hidden="true">{s.icon}</span>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m, i) => (
              <div key={m.id ?? i} className={cn("msg-in flex gap-3", m.role === "user" ? "justify-end" : "justify-start")}>
                {m.role === "assistant" ? (
                  <span className="mt-0.5 hidden h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-3 sm:grid" aria-hidden="true">
                    <MatrixMark className="h-5 w-5" />
                  </span>
                ) : null}
                <div className={cn("max-w-[88%] sm:max-w-[80%]")}>
                  <div
                    className={cn(
                      "rounded-2xl px-4 py-3",
                      m.role === "user"
                        ? "rounded-br-md bg-accent text-white shadow-[0_4px_16px_var(--accent-glow)]"
                        : "rounded-bl-md border border-border bg-surface-2",
                    )}
                  >
                    {m.role === "assistant" ? <Markdown text={m.content} /> : <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{m.content}</p>}
                  </div>
                  <div className={cn("mt-1 flex items-center gap-2 px-1 text-[10px] text-ink-3", m.role === "user" ? "justify-end" : "")}>
                    <span>{m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                    {m.role === "assistant" ? (
                      <button onClick={() => copyMessage(m.content)} className="font-semibold text-ink-3 transition-colors hover:text-accent">
                        Copy
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}

            {/* Streaming bubble */}
            {streaming ? (
              <div className="msg-in flex gap-3">
                <span className="mt-0.5 hidden h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-3 sm:grid" aria-hidden="true">
                  <MatrixMark className="h-5 w-5" />
                </span>
                <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-border bg-surface-2 px-4 py-3 sm:max-w-[80%]">
                  {streamedText ? (
                    <div className="ai-reply">
                      <Markdown text={streamedText} />
                      <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent align-middle" aria-hidden="true" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 py-1" role="status" aria-label="MATRIX is thinking">
                      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
                      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
                      <span className="typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
                      <span className="ml-1 text-xs text-ink-3">MATRIX is thinking…</span>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* Error + retry */}
            {error ? (
              <div className="card fade-in mx-auto max-w-md !border-danger/30 bg-danger-soft !p-4 text-center">
                <p className="text-sm font-semibold text-danger">Something went wrong.</p>
                <p className="mt-1 text-xs text-ink-2">{error}</p>
                <div className="mt-3 flex justify-center gap-2">
                  <Button variant="outline" onClick={retry} className="!min-h-9 !px-3 !py-1.5 text-xs">Retry</Button>
                  <Button variant="ghost" onClick={() => setError(null)} className="!min-h-9 !px-3 !py-1.5 text-xs">Dismiss</Button>
                </div>
              </div>
            ) : null}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {notice ? (
        <p className="mt-2 rounded-xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-sm text-accent">{notice}</p>
      ) : null}

      {/* Composer */}
      <form onSubmit={(e) => void send(e)} className="mt-3 flex items-end gap-2">
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void handleFile(e.target.files?.[0])} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={streaming}
          aria-label="Attach a screenshot for analysis"
          title="Attach a screenshot for analysis"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border-strong bg-surface text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          ＋
        </button>
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e);
            }
          }}
          placeholder={env.demoMode ? "Ask MATRIX about cybersecurity… (demo)" : "Ask MATRIX about cybersecurity…"}
          rows={1}
          aria-label="Message MATRIX"
          disabled={streaming}
          className="max-h-40 min-h-11 flex-1"
          autoFocus={typeof window !== "undefined" && window.innerWidth >= 1024}
        />
        {streaming ? (
          <Button type="button" variant="outline" onClick={stop} className="shrink-0" aria-label="Stop generating">
            ■ Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()} className="shrink-0 !px-4" aria-label="Send message">
            ↑
          </Button>
        )}
      </form>

      {/* Regenerate for the last exchange */}
      {!streaming && messages.length >= 2 && lastUserMessage && (
        <div className="mt-2 flex justify-center">
          <button
            onClick={regenerate}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            ↻ Regenerate response
          </button>
        </div>
      )}
    </div>
  );
}
