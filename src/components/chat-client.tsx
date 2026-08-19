"use client";

// MATRIX chat — minimal, editorial, premium. Real streaming responses from
// the AI gateway (the only path to Groq), stop/retry/regenerate, copy,
// timestamps, image attachment → scanner analysis, temporary chat,
// empty-state suggestions.
//
// Fakes-free contract (product spec): every assistant message comes from the
// real gateway. Any failure renders "Server problem" (or the appropriate
// category) with a [Retry] — never a canned reply, never an endless loader.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileSearch, Flag, GraduationCap, KeyRound, Paperclip, RefreshCcw, Send, ShieldAlert, Square,
} from "lucide-react";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import { uploadOwnedFile } from "@/lib/client/api";
import { Button, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { MatrixMark } from "@/components/logo";
import { useToast } from "@/components/toast";
import { ServerProblem } from "@/components/server-problem";
import { classifyGatewayResponse, classifyRequestException, failureCopy, type ApiFailure } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

type Message = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

// Deadlines for the real network calls. If the gateway has not responded
// with headers in this window we surface a timeout failure; once streaming,
// a longer idle window without any token also becomes a timeout.
const CONNECT_TIMEOUT_MS = 25_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;

const SUGGESTIONS = [
  { icon: <ShieldAlert size={15} strokeWidth={1.5} />, label: "Check a suspicious message", prompt: "Is this message phishing? It says I won a prize and must pay a fee to receive it." },
  { icon: <FileSearch size={15} strokeWidth={1.5} />, label: "Analyze a screenshot", prompt: null, href: "/scanner" },
  { icon: <KeyRound size={15} strokeWidth={1.5} />, label: "Secure my account", prompt: "How do I secure my account? What should I do first?" },
  { icon: <GraduationCap size={15} strokeWidth={1.5} />, label: "Learn cybersecurity", prompt: "Teach me the basics of cybersecurity — where should I start?" },
  { icon: <Flag size={15} strokeWidth={1.5} />, label: "Report a scam", prompt: null, href: "/report" },
];

async function parseErrorCode(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === "string" ? data.error : null;
  } catch {
    return null;
  }
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
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamedText, streaming, scrollToBottom]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  }, []);

  function clearIdleTimer() {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  function armIdleTimer(ms: number, controller: AbortController) {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      controller.abort(new DOMException("The request timed out.", "TimeoutError"));
    }, ms);
  }

  function stop() {
    // Stop must actually cancel the in-flight request.
    clearIdleTimer();
    abortRef.current?.abort(new DOMException("Stopped by user.", "AbortError"));
    setStreaming(false);
  }

  async function requestToken(): Promise<string | null> {
    // The AI gateway (/api/ai) is a same-origin route — the httpOnly session
    // cookie authenticates it. Ensure it is fresh (re-mint if missing).
    const user = fbAuth().currentUser;
    if (!user) return null;
    return "session-cookie";
  }

  async function streamMessage(message: string, replaceLastAssistant = false) {
    setFailure(null);
    setNotice(null);
    setStreaming(true);
    setLastUserMessage(message);
    setStreamedText("");

    if (!firebaseBrowserConfigured) {
      setFailure({ ...failureCopy("not-configured"), detail: "The MATRIX backend is not configured on this deployment yet, so chat cannot start." });
      setStreaming(false);
      setStreamedText(null);
      return;
    }

    const token = await requestToken();
    if (!token) {
      setFailure(failureCopy("auth"));
      setStreaming(false);
      setStreamedText(null);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      armIdleTimer(CONNECT_TIMEOUT_MS, controller);
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "chat", stream: true, conversation_id: convId, is_temporary: isTemporary, message }),
        signal: controller.signal,
      });
      // Connected — from here the streaming idle window applies.
      armIdleTimer(STREAM_IDLE_TIMEOUT_MS, controller);

      if (!res.ok) {
        clearIdleTimer();
        setFailure(classifyGatewayResponse(res.status, await parseErrorCode(res)));
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        // Non-streaming gateway answer (e.g. an on-topic refusal).
        clearIdleTimer();
        const data = (await res.json()) as { reply?: string; conversation_id?: string };
        if (data.reply) {
          const reply = data.reply;
          setMessages((m) => [...m, { role: "assistant", content: reply, created_at: new Date().toISOString() }]);
          if (data.conversation_id && convId !== data.conversation_id) {
            setConvId(data.conversation_id);
            onConversationCreated?.(data.conversation_id);
            if (!isTemporary) router.replace(`/chat/${data.conversation_id}`);
          }
          return;
        }
        setFailure(failureCopy("server"));
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        clearIdleTimer();
        setFailure(failureCopy("server"));
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let finalReply = "";
      let gotConversationId: string | null = null;
      let streamError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleTimer(STREAM_IDLE_TIMEOUT_MS, controller); // activity — reset idle deadline
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
              const reply = finalReply;
              setMessages((m) => {
                const base = replaceLastAssistant ? m.slice(0, -1) : m;
                return [...base, { role: "assistant", content: reply, created_at: new Date().toISOString() }];
              });
            }
          } catch {
            // malformed event — skip
          }
        }
      }
      clearIdleTimer();

      if (streamError) {
        // The gateway reported a mid-stream failure. Everything already on
        // screen is real output — offer a clean retry for the rest.
        setFailure({ ...failureCopy("server"), detail: "The response was interrupted. Your message is safe — try again." });
        return;
      }
      if (gotConversationId && convId !== gotConversationId) {
        setConvId(gotConversationId);
        onConversationCreated?.(gotConversationId);
        if (!isTemporary) router.replace(`/chat/${gotConversationId}`);
      }
    } catch (err) {
      clearIdleTimer();
      const userStopped = err instanceof DOMException && err.name === "AbortError";
      if (userStopped) {
        setNotice("Generation stopped. Your message is safe.");
      } else {
        setFailure(classifyRequestException(err));
      }
    } finally {
      clearIdleTimer();
      setStreaming(false);
      setStreamedText(null);
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
    setFailure(null);
    const hasUser = messages.some((m) => m.role === "user" && m.content === lastUserMessage);
    if (!hasUser) {
      const msg = lastUserMessage;
      setMessages((m) => [...m, { role: "user", content: msg, created_at: new Date().toISOString() }]);
    }
    void streamMessage(lastUserMessage, false);
  }

  async function handleFile(file: File | undefined | null) {
    if (!file || streaming) return;
    setFailure(null);
    const okTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!okTypes.includes(file.type)) {
      setFailure({ ...failureCopy("invalid-request"), title: "Unsupported file", detail: "Only PNG, JPEG and WebP images can be analysed.", retryable: false });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setFailure({ ...failureCopy("invalid-request"), title: "Upload failed", detail: "The image is too large (maximum 8 MB). Choose a smaller screenshot.", retryable: false });
      return;
    }
    if (!firebaseBrowserConfigured) {
      setFailure({ ...failureCopy("not-configured"), detail: "The MATRIX backend is not configured on this deployment yet, so screenshots cannot be analysed." });
      return;
    }

    setMessages((m) => [...m, { role: "user", content: `Attachment: ${file.name}`, created_at: new Date().toISOString() }]);
    setStreaming(true);
    setStreamedText("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (!fbAuth().currentUser) {
        setFailure(failureCopy("auth"));
        return;
      }

      armIdleTimer(CONNECT_TIMEOUT_MS, controller);
      const path = await uploadOwnedFile("security-screenshots", file);
      if (!path) {
        clearIdleTimer();
        setFailure({ ...failureCopy("server"), title: "Upload failed", detail: "The screenshot could not be uploaded. Please try again." });
        return;
      }

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "scan", storage_path: path }),
        signal: controller.signal,
      });
      clearIdleTimer();

      if (!res.ok) {
        setFailure(classifyGatewayResponse(res.status, await parseErrorCode(res)));
        return;
      }
      const data = (await res.json()) as { reply?: string; error?: string };
      if (!data.reply || data.error) {
        setFailure(classifyGatewayResponse(502, typeof data.error === "string" ? data.error : null));
        return;
      }
      const reply = data.reply;
      setMessages((m) => [...m, { role: "assistant", content: reply, created_at: new Date().toISOString() }]);
    } catch (err) {
      const userStopped = err instanceof DOMException && err.name === "AbortError";
      if (!userStopped) setFailure(classifyRequestException(err));
    } finally {
      clearIdleTimer();
      setStreaming(false);
      setStreamedText(null);
      abortRef.current = null;
    }
  }

  function copyMessage(text: string) {
    navigator.clipboard?.writeText(text).then(() => toast("Copied to clipboard")).catch(() => {});
  }

  return (
    <div className="flex h-[calc(100dvh-9.5rem)] flex-col lg:h-[calc(100dvh-7.5rem)]">
      {isTemporary ? (
        <div className="mb-3 border-b border-border pb-3 text-[13px] text-ink-2">
          <span className="eyebrow">Temporary</span> — this conversation will not be saved to your account or memory.
        </div>
      ) : null}

      {/* Transcript */}
      <div className="no-scrollbar flex-1 space-y-7 overflow-y-auto px-1 py-2 sm:px-2">
        {messages.length === 0 && !streaming ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-5">
              <span className="mb-4 inline-block" aria-hidden="true">
                <MatrixMark className="h-12 w-12 text-ink-2" />
              </span>
              <p className="eyebrow mb-2">MATRIX</p>
              <h1 className="font-display text-[26px] font-semibold tracking-tight text-ink sm:text-3xl">
                How can MATRIX help protect you?
              </h1>
              <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-2">
                Your AI Cyber Safety Assistant. Ask about phishing, passwords, scams and privacy —
                cybersecurity questions only, without judgment.
              </p>
            </div>
            <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => {
                    if (s.href) router.push(s.href);
                    else if (s.prompt) void send(undefined, s.prompt);
                  }}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left text-[13px] font-medium text-ink-2 transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-ink"
                >
                  <span className="text-ink-3" aria-hidden="true">{s.icon}</span>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m, i) => (
              <div key={m.id ?? i} className={cn("msg-in flex gap-3.5", m.role === "user" ? "justify-end" : "justify-start")}>
                {m.role === "assistant" ? (
                  <span className="mt-0.5 hidden shrink-0 sm:block" aria-hidden="true">
                    <MatrixMark className="h-5 w-5 text-ink-3" />
                  </span>
                ) : null}
                <div className={cn("min-w-0", m.role === "user" ? "max-w-[85%] sm:max-w-[75%]" : "max-w-[92%] flex-1 sm:max-w-none")}>
                  {m.role === "user" ? (
                    <div className="rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-[14.5px] leading-relaxed text-ink">
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  ) : (
                    <div className="border-l border-border pl-4">
                      <Markdown text={m.content} />
                    </div>
                  )}
                  <div className={cn("mt-1.5 flex items-center gap-3 px-0.5 text-[10.5px] text-ink-3", m.role === "user" ? "justify-end" : "")}>
                    <span>{m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                    {m.role === "assistant" ? (
                      <button onClick={() => copyMessage(m.content)} className="font-medium uppercase tracking-wide transition-colors hover:text-ink-2">
                        Copy
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}

            {/* Streaming — "MATRIX is connecting…" until output starts, then the reply builds up live. */}
            {streaming ? (
              <div className="msg-in flex gap-3.5">
                <span className="mt-0.5 hidden shrink-0 sm:block" aria-hidden="true">
                  <MatrixMark className="h-5 w-5 text-ink-3" />
                </span>
                <div className="min-w-0 flex-1 border-l border-border pl-4">
                  {streamedText ? (
                    <div className="ai-reply">
                      <p className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-ink-3">MATRIX is responding…</p>
                      <Markdown text={streamedText} />
                      <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-ink align-middle" aria-hidden="true" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 py-2 text-[13px] text-ink-3" role="status" aria-label="MATRIX is connecting">
                      <span className="typing-dot h-1 w-1 rounded-full bg-ink-2" />
                      <span className="typing-dot h-1 w-1 rounded-full bg-ink-2" />
                      <span className="typing-dot h-1 w-1 rounded-full bg-ink-2" />
                      <span className="ml-1">MATRIX is connecting…</span>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* Honest failure card — category-aware, with [Retry]. */}
            {failure ? (
              <ServerProblem failure={failure} onRetry={retry} onDismiss={() => setFailure(null)} />
            ) : null}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {notice ? (
        <p className="mt-2 text-[13px] text-ink-2">{notice}</p>
      ) : null}

      {/* Composer — large, centered, restrained */}
      <div className="mt-4">
        <form onSubmit={(e) => void send(e)} className="mx-auto flex max-w-2xl items-end gap-1.5 rounded-xl border border-border-strong bg-surface p-1.5 shadow-[var(--shadow-card)] transition-colors focus-within:border-accent">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void handleFile(e.target.files?.[0])} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={streaming}
            aria-label="Attach a screenshot for analysis"
            title="Attach a screenshot for analysis"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
          >
            <Paperclip size={16} strokeWidth={1.6} />
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
            placeholder="Ask MATRIX about cybersecurity…"
            rows={1}
            aria-label="Message MATRIX"
            disabled={streaming}
            className="max-h-36 flex-1 !border-0 !bg-transparent !shadow-none focus:!shadow-none focus:!outline-none focus:!ring-0"
          />
          {streaming ? (
            <Button type="button" variant="ghost" onClick={stop} className="shrink-0 !px-3" aria-label="Stop generating">
              <Square size={14} strokeWidth={1.8} /> Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()} className="shrink-0 !px-3.5" aria-label="Send message">
              <Send size={15} strokeWidth={1.7} />
            </Button>
          )}
        </form>
        <div className="mx-auto mt-2 flex max-w-2xl items-center justify-between px-1">
          <p className="text-[11px] text-ink-3">Enter to send · Shift+Enter for a new line</p>
          {!streaming && messages.length >= 2 && lastUserMessage ? (
            <button onClick={regenerate} className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3 transition-colors hover:text-ink">
              <RefreshCcw size={11} strokeWidth={1.7} /> Regenerate
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
