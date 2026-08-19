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
import { firebaseBrowserConfigured, waitForAuthUser } from "@/lib/firebase/client";
import { uploadOwnedFile } from "@/lib/client/api";
import { Button, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { MatrixMark, MatrixWordmark } from "@/components/logo";
import { useToast } from "@/components/toast";
import { ServerProblem } from "@/components/server-problem";
import { classifyGatewayResponse, classifyRequestException, failureCopy, type ApiFailure } from "@/lib/api-errors";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Message = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

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

function lastUserContent(list: Message[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "user") return list[i].content;
  }
  return null;
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
  const { t, locale } = useI18n();
  const suggestions = locale === "bn" ? [
    { icon: <ShieldAlert size={15} strokeWidth={1.5} />, label: "সন্দেহজনক মেসেজ যাচাই করুন", prompt: "এই মেসেজটি কি ফিশিং? এখানে বলা হয়েছে আমি পুরস্কার জিতেছি এবং পেতে আগে টাকা দিতে হবে।", href: undefined },
    { icon: <FileSearch size={15} strokeWidth={1.5} />, label: "স্ক্রিনশট বিশ্লেষণ করুন", prompt: null, href: "/scanner" },
    { icon: <KeyRound size={15} strokeWidth={1.5} />, label: "অ্যাকাউন্ট নিরাপদ করুন", prompt: "আমার অ্যাকাউন্ট নিরাপদ করতে প্রথমে কী কী করা উচিত?", href: undefined },
    { icon: <GraduationCap size={15} strokeWidth={1.5} />, label: "কম্পিউটার ও সাইবার শিখুন", prompt: "কম্পিউটার ও সাইবার নিরাপত্তার মৌলিক বিষয় সহজভাবে শেখান।", href: undefined },
    { icon: <Flag size={15} strokeWidth={1.5} />, label: "স্ক্যাম রিপোর্ট করুন", prompt: null, href: "/report" },
  ] : SUGGESTIONS;
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [convId, setConvId] = useState<string | null>(initialConvId);
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(lastUserContent(initialMessages));
  const [keyboardInset, setKeyboardInset] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const convIdRef = useRef<string | null>(initialConvId);

  useEffect(() => {
    convIdRef.current = convId;
  }, [convId]);

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

  // Keep the composer above the iOS/Android keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardInset(inset > 40 ? inset : 0);
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    sync();
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  function autosize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }

  function rememberConv(id: string | null) {
    if (!id || convIdRef.current === id) return;
    convIdRef.current = id;
    setConvId(id);
    onConversationCreated?.(id);
  }

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

  function commitPartial(text: string, replaceLastAssistant: boolean) {
    const reply = text.trim();
    if (!reply) return;
    setMessages((m) => {
      const base = replaceLastAssistant && m[m.length - 1]?.role === "assistant" ? m.slice(0, -1) : m;
      const last = base[base.length - 1];
      if (last?.role === "assistant" && last.content === reply) return base;
      return [...base, { role: "assistant", content: reply, created_at: new Date().toISOString() }];
    });
  }

  function stop() {
    clearIdleTimer();
    abortRef.current?.abort(new DOMException("Stopped by user.", "AbortError"));
    setStreaming(false);
  }

  async function streamMessage(message: string, opts: { replaceLastAssistant?: boolean; reuseUser?: boolean; regenerate?: boolean } = {}) {
    const replaceLastAssistant = opts.replaceLastAssistant === true;
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

    // Session cookie authenticates /api/ai — do NOT require Firebase currentUser
    // (it is often still null for a beat after a refresh, which used to fail every send).
    const controller = new AbortController();
    abortRef.current = controller;
    let collected = "";
    let committed = false;

    try {
      armIdleTimer(CONNECT_TIMEOUT_MS, controller);
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "chat",
          stream: true,
          conversation_id: convIdRef.current,
          is_temporary: isTemporary,
          message,
          language: locale,
          regenerate: opts.regenerate === true,
          reuse_user: opts.reuseUser === true || opts.regenerate === true,
        }),
        signal: controller.signal,
      });
      armIdleTimer(STREAM_IDLE_TIMEOUT_MS, controller);

      if (!res.ok) {
        clearIdleTimer();
        setFailure(classifyGatewayResponse(res.status, await parseErrorCode(res)));
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        clearIdleTimer();
        const data = (await res.json()) as { reply?: string; conversation_id?: string };
        if (data.conversation_id) rememberConv(data.conversation_id);
        if (data.reply) {
          commitPartial(data.reply, replaceLastAssistant);
          committed = true;
          if (data.conversation_id && !isTemporary) router.replace(`/chat/${data.conversation_id}`);
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
      let streamError: string | null = null;
      let gotConversationId: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleTimer(STREAM_IDLE_TIMEOUT_MS, controller);
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
              collected += data.delta;
              setStreamedText(collected);
            }
            if (data.conversation_id) {
              gotConversationId = data.conversation_id;
              rememberConv(data.conversation_id);
            }
            if (data.error) streamError = data.error;
            if (data.done) {
              commitPartial(collected, replaceLastAssistant);
              committed = true;
            }
          } catch {
            // malformed event — skip
          }
        }
      }
      clearIdleTimer();

      if (!committed && collected.trim()) {
        commitPartial(collected, replaceLastAssistant);
        committed = true;
      }
      if (streamError && !collected.trim()) {
        setFailure({ ...failureCopy("server"), detail: "The response was interrupted. Your message is safe — try again." });
        return;
      }
      if (gotConversationId && !isTemporary && !initialConvId) {
        // Navigate only after the stream finished so we don't abort it.
        router.replace(`/chat/${gotConversationId}`);
      }
    } catch (err) {
      clearIdleTimer();
      const userStopped = err instanceof DOMException && err.name === "AbortError";
      if (collected.trim()) {
        commitPartial(collected, replaceLastAssistant);
        committed = true;
      }
      if (userStopped) {
        setNotice(collected.trim() ? "Generation stopped." : "Generation stopped. Your message is safe.");
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

  async function send(e?: { preventDefault(): void }, messageOverride?: string) {
    e?.preventDefault();
    const message = (messageOverride ?? input).trim();
    if (!message || streaming) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setMessages((m) => [...m, { role: "user", content: message, created_at: new Date().toISOString() }]);
    await streamMessage(message);
  }

  function regenerate() {
    if (!lastUserMessage || streaming) return;
    void streamMessage(lastUserMessage, { replaceLastAssistant: true, regenerate: true, reuseUser: true });
  }

  function retry() {
    if (!lastUserMessage || streaming) return;
    setFailure(null);
    const hasUser = messages.some((m) => m.role === "user" && m.content === lastUserMessage);
    if (!hasUser) {
      const msg = lastUserMessage;
      setMessages((m) => [...m, { role: "user", content: msg, created_at: new Date().toISOString() }]);
    }
    void streamMessage(lastUserMessage, { reuseUser: Boolean(convIdRef.current) });
  }

  async function handleFile(file: File | undefined | null) {
    if (!file || streaming) return;
    setFailure(null);
    if (fileRef.current) fileRef.current.value = "";
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
      const user = await waitForAuthUser();
      if (!user) {
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
      setMessages((m) => [...m, { role: "assistant", content: data.reply!, created_at: new Date().toISOString() }]);
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
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}
    >
      {isTemporary ? (
        <div className="mb-3 shrink-0 border-b border-border pb-3 text-[13px] text-ink-2">
          <span className="eyebrow">Temporary</span> — {t("chat.tempNotice").replace(/^Temporary Chat — /, "")}
        </div>
      ) : null}

      <div className="no-scrollbar min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-0.5 py-2 sm:px-2">
        {messages.length === 0 && !streaming ? (
          <div className="flex min-h-full flex-col items-center justify-center px-1 py-6 text-center">
            <div className="mb-5">
              <span className="mb-3 inline-block" aria-hidden="true">
                <MatrixWordmark className="h-14 w-56 sm:h-16 sm:w-64" />
              </span>
              <p className="eyebrow flourish mb-2">{locale === "bn" ? "ডিজিটাল সহায়তা ও সাইবার সচেতনতা" : "Digital help & cyber awareness"}</p>
              <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink sm:text-3xl">
                {t("chat.title")}
              </h1>
              <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-2">
                {locale === "bn"
                  ? "বাংলা, Banglish বা English-এ কম্পিউটার, মোবাইল, অ্যাপ, ইন্টারনেট, আইটি, গোপনীয়তা, স্ক্যাম ও সাইবার নিরাপত্তা নিয়ে যেকোনো প্রশ্ন করুন।"
                  : "Ask in English, Bangla or Banglish about computers, phones, apps, the internet, IT, privacy, scams and cybersecurity."}
              </p>
            </div>
            <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => {
                    if (s.href) router.push(s.href);
                    else if (s.prompt) void send(undefined, s.prompt);
                  }}
                  className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left text-[13px] font-medium text-ink-2 transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-ink"
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
                <div className={cn("min-w-0", m.role === "user" ? "max-w-[88%] sm:max-w-[75%]" : "max-w-[96%] flex-1 sm:max-w-none")}>
                  {m.role === "user" ? (
                    <div className="rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-[14.5px] leading-relaxed text-ink">
                      <p className="whitespace-pre-wrap break-words">{m.content}</p>
                    </div>
                  ) : (
                    <div className="border-l border-border pl-4">
                      <Markdown text={m.content} />
                    </div>
                  )}
                  <div className={cn("mt-1.5 flex items-center gap-3 px-0.5 text-[10.5px] text-ink-3", m.role === "user" ? "justify-end" : "")}>
                    <span>{m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                    {m.role === "assistant" ? (
                      <button
                        type="button"
                        onClick={() => copyMessage(m.content)}
                        className="min-h-8 min-w-8 font-medium uppercase tracking-wide transition-colors hover:text-ink-2"
                      >
                        Copy
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}

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

            {failure ? (
              <ServerProblem failure={failure} onRetry={retry} onDismiss={() => setFailure(null)} />
            ) : null}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {notice ? (
        <p className="mt-2 shrink-0 text-[13px] text-ink-2">{notice}</p>
      ) : null}

      <div className="shrink-0 pt-3">
        <form
          onSubmit={(e) => void send(e)}
          className="mx-auto flex max-w-2xl items-end gap-1.5 rounded-xl border border-border-strong bg-surface p-1.5 shadow-[var(--shadow-card)] transition-colors focus-within:border-accent"
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={streaming}
            aria-label="Attach a screenshot for analysis"
            title="Attach a screenshot for analysis"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
          >
            <Paperclip size={16} strokeWidth={1.6} />
          </button>
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              requestAnimationFrame(autosize);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(e);
              }
            }}
            placeholder={t("chat.placeholder")}
            rows={1}
            aria-label="Message MATRIX"
            disabled={streaming}
            className="max-h-36 min-h-11 flex-1 !border-0 !bg-transparent !px-1 !py-2.5 !shadow-none focus:!shadow-none focus:!outline-none focus:!ring-0"
          />
          {streaming ? (
            <Button type="button" variant="ghost" onClick={stop} className="h-11 shrink-0 !px-3" aria-label="Stop generating">
              <Square size={14} strokeWidth={1.8} /> Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()} className="h-11 shrink-0 !px-3.5" aria-label={t("chat.send")}>
              <Send size={15} strokeWidth={1.7} />
            </Button>
          )}
        </form>
        <div className="mx-auto mt-2 flex max-w-2xl items-center justify-between gap-2 px-1 pb-1">
          <p className="hidden text-[11px] text-ink-3 sm:block">Enter to send · Shift+Enter for a new line</p>
          <p className="text-[11px] text-ink-3 sm:hidden">Tap send · Shift+Enter for a new line</p>
          {!streaming && messages.length >= 2 && lastUserMessage ? (
            <button
              type="button"
              onClick={regenerate}
              className="flex min-h-8 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3 transition-colors hover:text-ink"
            >
              <RefreshCcw size={11} strokeWidth={1.7} /> Regenerate
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
