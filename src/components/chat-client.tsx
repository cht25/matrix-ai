"use client";

// MATRIX chat — minimal, editorial, premium. Real streaming responses from
// the AI gateway (Groq for general chat; OpenRouter Nemotron for code),
// stop/retry/regenerate, file attachments, Agent artifacts, live preview,
// explicit GitHub push, temporary chat and task-focused empty states.
//
// Fakes-free contract (product spec): every assistant message comes from the
// real gateway. Any failure renders "Server problem" (or the appropriate
// category) with a [Retry] — never a canned reply, never an endless loader.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot, BrainCircuit, Code2, FileCode2, FileSearch, Github, GraduationCap,
  MonitorPlay, Paperclip, RefreshCcw, Send, ShieldAlert, Sparkles, Square, X,
} from "lucide-react";
import { AutoSpeakToggle, ListenButton } from "@/components/chat-speech-controls";
import {
  primeSpeech, readAutoSpeakPreference, speakMarkdown, stopSpeech, writeAutoSpeakPreference,
} from "@/lib/chat-speech";
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
import type { AgentFile, ChatMode, TextAttachment } from "@/lib/ai/agent";
import { AgentWorkspace } from "@/components/agent-workspace";
import { ThemeGallery } from "@/components/theme-gallery";
import { rpc } from "@/lib/client/api";

type MessageMetadata = {
  mode?: ChatMode;
  model?: string;
  coding_detected?: boolean;
  artifacts?: AgentFile[];
  attachment_names?: string[];
  action?: string;
  project_id?: string;
};

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  metadata?: MessageMetadata;
};

type PendingAttachment = TextAttachment & { size: number };

const CONNECT_TIMEOUT_MS = 25_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;

const SUGGESTIONS = [
  { icon: <Sparkles size={15} strokeWidth={1.5} />, label: "Plan or brainstorm", prompt: "Help me turn an idea into a clear step-by-step plan." },
  { icon: <BrainCircuit size={15} strokeWidth={1.5} />, label: "Explain something", prompt: "Explain a difficult topic simply, then give me a practical example." },
  { icon: <FileSearch size={15} strokeWidth={1.5} />, label: "Analyse a file or image", prompt: null, action: "attach" },
  { icon: <Code2 size={15} strokeWidth={1.5} />, label: "Build with Agent", prompt: null, href: "/chat?mode=agent" },
  { icon: <ShieldAlert size={15} strokeWidth={1.5} />, label: "Check something suspicious", prompt: "Help me check whether a message, link or situation is suspicious." },
  { icon: <GraduationCap size={15} strokeWidth={1.5} />, label: "Learn a new skill", prompt: "Help me learn a useful new skill with a short beginner lesson and an exercise." },
];

const AGENT_SUGGESTIONS = [
  { icon: <Code2 size={15} strokeWidth={1.5} />, label: "Build a responsive website", prompt: "Build a polished responsive website from my description. Start by asking only for the one most important missing requirement." },
  { icon: <FileCode2 size={15} strokeWidth={1.5} />, label: "Fix an attached project", prompt: "Review the attached project files, identify the root cause, and return complete corrected files." },
  { icon: <MonitorPlay size={15} strokeWidth={1.5} />, label: "Create a live prototype", prompt: "Create a self-contained HTML, CSS and JavaScript prototype that I can open in Live Preview." },
  { icon: <Github size={15} strokeWidth={1.5} />, label: "Prepare a GitHub change", prompt: "Prepare a focused, production-ready code change with complete files and a verification checklist." },
];

async function parseErrorCode(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === "string" ? data.error : null;
  } catch {
    return null;
  }
}

function lastUserContent(list: ChatMessage[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "user") return list[i].content;
  }
  return null;
}

function latestArtifacts(list: ChatMessage[]): AgentFile[] {
  for (let i = list.length - 1; i >= 0; i--) {
    const files = list[i].metadata?.artifacts;
    if (Array.isArray(files) && files.length) return files;
  }
  return [];
}

function latestProjectId(list: ChatMessage[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const pid = list[i].metadata?.project_id;
    if (typeof pid === "string" && pid) return pid;
  }
  return null;
}

export function ChatClient({
  initialMessages,
  conversationId: initialConvId,
  isTemporary,
  initialMode = "general",
  onConversationCreated,
}: {
  initialMessages: ChatMessage[];
  conversationId: string | null;
  isTemporary: boolean;
  initialMode?: ChatMode;
  onConversationCreated?: (id: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<ChatMode>(isTemporary ? "general" : initialMode);
  const suggestions = mode === "agent" ? AGENT_SUGGESTIONS : locale === "bn" ? [
    { icon: <Sparkles size={15} strokeWidth={1.5} />, label: "পরিকল্পনা বা আইডিয়া", prompt: "আমার একটি আইডিয়াকে পরিষ্কার ধাপে ধাপে পরিকল্পনায় সাজাতে সাহায্য করুন।" },
    { icon: <BrainCircuit size={15} strokeWidth={1.5} />, label: "সহজভাবে বুঝিয়ে দিন", prompt: "একটি কঠিন বিষয় সহজভাবে বুঝিয়ে একটি বাস্তব উদাহরণ দিন।" },
    { icon: <FileSearch size={15} strokeWidth={1.5} />, label: "ফাইল বা ছবি বিশ্লেষণ", prompt: null, action: "attach" },
    { icon: <Code2 size={15} strokeWidth={1.5} />, label: "Agent দিয়ে তৈরি করুন", prompt: null, href: "/chat?mode=agent" },
  ] : SUGGESTIONS;
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [convId, setConvId] = useState<string | null>(initialConvId);
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(lastUserContent(initialMessages));
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [agentFiles, setAgentFiles] = useState<AgentFile[]>(latestArtifacts(initialMessages));
  const [agentProjectId, setAgentProjectId] = useState<string | null>(latestProjectId(initialMessages));
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [lastModel, setLastModel] = useState<string | null>(() => {
    for (let i = initialMessages.length - 1; i >= 0; i--) if (initialMessages[i].metadata?.model) return initialMessages[i].metadata!.model!;
    return null;
  });
  const abortRef = useRef<AbortController | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const convIdRef = useRef<string | null>(initialConvId);
  const lastAttachmentsRef = useRef<PendingAttachment[]>([]);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const autoSpeakRef = useRef(true);
  const localeRef = useRef(locale);

  useEffect(() => {
    convIdRef.current = convId;
  }, [convId]);

  useEffect(() => {
    const preferred = readAutoSpeakPreference(true);
    setAutoSpeak(preferred);
    autoSpeakRef.current = preferred;
  }, []);

  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
  }, [autoSpeak]);

  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamedText, streaming, scrollToBottom]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    stopSpeech();
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

  function switchMode(next: ChatMode) {
    if (next === mode || isTemporary || streaming) return;
    stopSpeech();
    setSpeakingId(null);
    if (convIdRef.current || messages.length > 0) {
      router.push(`/chat?mode=${next}&new=${Date.now()}`);
      return;
    }
    setMode(next);
    setAttachments([]);
    setFailure(null);
    setNotice(null);
    router.replace(`/chat?mode=${next}`);
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

  function commitPartial(text: string, replaceLastAssistant: boolean, metadata: MessageMetadata = {}) {
    const reply = text.trim();
    if (!reply) return;
    if (metadata.model) setLastModel(metadata.model);
    if (metadata.project_id) setAgentProjectId(metadata.project_id);
    if (metadata.artifacts?.length) {
      setAgentFiles(metadata.artifacts);
      setWorkspaceOpen(true);
    }
    setMessages((m) => {
      const base = replaceLastAssistant && m[m.length - 1]?.role === "assistant" ? m.slice(0, -1) : m;
      const last = base[base.length - 1];
      if (last?.role === "assistant" && last.content === reply) return base;
      return [...base, { role: "assistant", content: reply, created_at: new Date().toISOString(), metadata }];
    });
  }

  function stop() {
    clearIdleTimer();
    abortRef.current?.abort(new DOMException("Stopped by user.", "AbortError"));
    setStreaming(false);
  }

  function toggleAutoSpeak() {
    const next = !autoSpeak;
    setAutoSpeak(next);
    autoSpeakRef.current = next;
    writeAutoSpeakPreference(next);
    if (!next) {
      stopSpeech();
      setSpeakingId(null);
    }
  }

  function listenTo(id: string, text: string, isLatest = false) {
    if (mode === "agent") return;
    if (speakingId === id || (speakingId === "auto" && isLatest)) {
      stopSpeech();
      setSpeakingId(null);
      return;
    }
    primeSpeech();
    const ok = speakMarkdown(text, {
      locale: localeRef.current,
      onend: () => setSpeakingId((current) => (current === id ? null : current)),
      onerror: () => setSpeakingId((current) => (current === id ? null : current)),
    });
    setSpeakingId(ok ? id : null);
  }

  function maybeAutoSpeak(text: string) {
    if (mode === "agent" || !autoSpeakRef.current) return;
    const cleaned = text.trim();
    if (!cleaned) return;
    const ok = speakMarkdown(cleaned, {
      locale: localeRef.current,
      onend: () => setSpeakingId((current) => (current === "auto" ? null : current)),
      onerror: () => setSpeakingId((current) => (current === "auto" ? null : current)),
    });
    setSpeakingId(ok ? "auto" : null);
  }

  async function streamMessage(message: string, opts: { replaceLastAssistant?: boolean; reuseUser?: boolean; regenerate?: boolean; attachments?: PendingAttachment[] } = {}) {
    const replaceLastAssistant = opts.replaceLastAssistant === true;
    const sentAttachments = opts.attachments ?? [];
    setFailure(null);
    setNotice(null);
    setStreaming(true);
    setLastUserMessage(message);
    setStreamedText("");
    stopSpeech();
    setSpeakingId(null);
    if (mode !== "agent" && autoSpeakRef.current) primeSpeech();

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
    const streamMetadata: MessageMetadata = {};

    try {
      armIdleTimer(mode === "agent" ? 180_000 : CONNECT_TIMEOUT_MS, controller);
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "chat",
          stream: mode !== "agent",
          conversation_id: convIdRef.current,
          is_temporary: isTemporary,
          mode,
          message,
          attachments: sentAttachments.map(({ name, content, type }) => ({ name, content, type })),
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
        const data = (await res.json()) as {
          reply?: string;
          conversation_id?: string;
          files?: AgentFile[];
          project_id?: string | null;
          model?: string;
          mode?: ChatMode;
          coding_detected?: boolean;
          theme_gallery?: boolean;
        };
        if (data.conversation_id) rememberConv(data.conversation_id);
        // The project is created and files are persisted server-side; the
        // workspace reuses it via project_id (or the conversation id).
        if (data.project_id) setAgentProjectId(data.project_id);
        if (data.reply) {
          commitPartial(data.reply, replaceLastAssistant, {
            artifacts: data.files,
            project_id: data.project_id ?? undefined,
            model: data.model,
            mode: data.mode,
            coding_detected: data.coding_detected,
            action: data.theme_gallery ? "theme_gallery" : undefined,
          });
          committed = true;
          maybeAutoSpeak(data.reply);
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
              delta?: string;
              done?: boolean;
              conversation_id?: string;
              error?: string;
              model?: string;
              mode?: ChatMode;
              coding_detected?: boolean;
            };
            if (data.model) streamMetadata.model = data.model;
            if (data.mode) streamMetadata.mode = data.mode;
            if (typeof data.coding_detected === "boolean") streamMetadata.coding_detected = data.coding_detected;
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
              commitPartial(collected, replaceLastAssistant, streamMetadata);
              committed = true;
              maybeAutoSpeak(collected);
            }
          } catch {
            // malformed event — skip
          }
        }
      }
      clearIdleTimer();

      if (!committed && collected.trim()) {
        commitPartial(collected, replaceLastAssistant, streamMetadata);
        committed = true;
        maybeAutoSpeak(collected);
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
        commitPartial(collected, replaceLastAssistant, streamMetadata);
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
    const pending = messageOverride ? [] : attachments;
    const message = (messageOverride ?? input).trim() || (pending.length ? "Review these attached files and help me with them." : "");
    if (!message || streaming) return;
    setInput("");
    lastAttachmentsRef.current = pending;
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setMessages((m) => [...m, {
      role: "user",
      content: message,
      created_at: new Date().toISOString(),
      metadata: { mode, attachment_names: pending.map((file) => file.name) },
    }]);
    await streamMessage(message, { attachments: pending });
  }

  function regenerate() {
    if (!lastUserMessage || streaming) return;
    void streamMessage(lastUserMessage, { replaceLastAssistant: true, regenerate: true, reuseUser: true, attachments: lastAttachmentsRef.current });
  }

  function retry() {
    if (!lastUserMessage || streaming) return;
    setFailure(null);
    const hasUser = messages.some((m) => m.role === "user" && m.content === lastUserMessage);
    if (!hasUser) {
      const msg = lastUserMessage;
      setMessages((m) => [...m, { role: "user", content: msg, created_at: new Date().toISOString() }]);
    }
    void streamMessage(lastUserMessage, { reuseUser: Boolean(convIdRef.current), attachments: lastAttachmentsRef.current });
  }

  async function handleFile(file: File | undefined | null) {
    if (!file || streaming) return;
    setFailure(null);
    if (fileRef.current) fileRef.current.value = "";
    const okTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!okTypes.includes(file.type)) {
      const allowedName = /(?:^|\.)(?:txt|md|mdx|json|jsonc|js|jsx|mjs|cjs|ts|tsx|py|html?|css|scss|sass|less|vue|svelte|sql|graphql|ya?ml|toml|xml|env|sh|bash|go|rs|java|kt|php|rb|swift|dart|c|h|cc|cpp|cs)$/i.test(file.name) || /^(?:Dockerfile|Makefile)$/i.test(file.name);
      if (!allowedName) {
        setFailure({ ...failureCopy("invalid-request"), title: "Unsupported file", detail: "Attach an image, text document, or common source-code file. Archives and executable files are not accepted.", retryable: false });
        return;
      }
      if (file.size > 1024 * 1024) {
        setFailure({ ...failureCopy("invalid-request"), title: "File too large", detail: "Text and code files must be 1 MB or smaller. Attach only the relevant files.", retryable: false });
        return;
      }
      if (attachments.length >= 8) {
        setFailure({ ...failureCopy("invalid-request"), title: "Attachment limit reached", detail: "You can attach up to 8 text or code files in one message.", retryable: false });
        return;
      }
      try {
        const content = await file.text();
        setAttachments((current) => [...current.filter((item) => item.name !== file.name), { name: file.name, type: file.type, content, size: file.size }]);
        setNotice(`${file.name} is ready. Add an instruction, then send.`);
      } catch {
        setFailure({ ...failureCopy("invalid-request"), title: "File could not be read", detail: "Choose a plain-text or source-code file and try again.", retryable: false });
      }
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
    if (mode === "agent" && attachments.length >= 8) {
      setFailure({ ...failureCopy("invalid-request"), title: "Attachment limit reached", detail: "You can attach up to 8 files in one Agent request.", retryable: false });
      return;
    }

    if (mode !== "agent") {
      setMessages((m) => [...m, { role: "user", content: `Attachment: ${file.name}`, created_at: new Date().toISOString() }]);
      if (autoSpeakRef.current) primeSpeech();
    }
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
        body: JSON.stringify({ action: "scan", storage_path: path, purpose: mode === "agent" ? "agent_reference" : "security_scan" }),
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
      if (mode === "agent") {
        setAttachments((current) => [
          ...current.filter((item) => item.name !== file.name),
          {
            name: file.name,
            type: "text/plain",
            content: `Visual reference derived from the attached image ${file.name}:\n${data.reply}`,
            size: file.size,
          },
        ]);
        setNotice(`${file.name} was inspected and is ready as Agent context. Add an instruction, then send.`);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.reply!, created_at: new Date().toISOString() }]);
        maybeAutoSpeak(data.reply!);
      }
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
      {!isTemporary ? (
        <div className="mb-2 flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border py-1.5">
          <div className="inline-flex items-center rounded-lg border border-border bg-surface p-1" aria-label="Conversation mode">
            <button
              type="button"
              onClick={() => switchMode("general")}
              disabled={streaming}
              className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors", mode === "general" ? "bg-surface-2 text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
              aria-pressed={mode === "general"}
            >
              <Bot size={13} /> Chat
            </button>
            <button
              type="button"
              onClick={() => switchMode("agent")}
              disabled={streaming}
              className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors", mode === "agent" ? "bg-accent text-white shadow-sm" : "text-ink-3 hover:text-ink")}
              aria-pressed={mode === "agent"}
            >
              <Code2 size={13} /> Agent
            </button>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span title="Coding requests are automatically routed to NVIDIA Nemotron 3 Ultra through OpenRouter" className="hidden max-w-56 truncate text-[10.5px] font-medium uppercase tracking-[0.1em] text-ink-3 sm:block">
              {mode === "agent" ? "Nemotron 3 Ultra · OpenRouter" : lastModel?.includes("nemotron") ? "Coding detected · Nemotron" : "Automatic model routing"}
            </span>
            {mode === "agent" ? (
              <button
                type="button"
                onClick={() => setWorkspaceOpen(true)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-ink-2 hover:border-border-strong hover:bg-surface-2 hover:text-ink"
              >
                <MonitorPlay size={13} /> Workspace{agentFiles.length ? ` · ${agentFiles.length}` : ""}
              </button>
            ) : (
              <AutoSpeakToggle on={autoSpeak} onToggle={toggleAutoSpeak} onLabel={t("chat.autoSpeakOn")} offLabel={t("chat.autoSpeakOff")} />
            )}
          </div>
        </div>
      ) : null}

      {isTemporary ? (
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3 border-b border-border pb-3 text-[13px] text-ink-2">
          <p><span className="eyebrow">Temporary</span> — {t("chat.tempNotice").replace(/^Temporary Chat — /, "")}</p>
          <AutoSpeakToggle on={autoSpeak} onToggle={toggleAutoSpeak} onLabel={t("chat.autoSpeakOn")} offLabel={t("chat.autoSpeakOff")} />
        </div>
      ) : null}

      <div className="no-scrollbar min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-0.5 py-2 sm:px-2">
        {messages.length === 0 && !streaming ? (
          <div className="flex min-h-full flex-col items-center justify-center px-1 py-6 text-center">
            <div className="mb-5">
              <span className="mb-3 inline-block" aria-hidden="true">
                <MatrixWordmark className="h-14 w-56 sm:h-16 sm:w-64" />
              </span>
              <p className="eyebrow flourish mb-2">
                {mode === "agent" ? "Plan · Build · Preview · Push" : locale === "bn" ? "একটি সহকারী, সব ধরনের কাজে" : "One assistant for the whole task"}
              </p>
              <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink sm:text-3xl">
                {mode === "agent" ? "What should we build?" : locale === "bn" ? "আজ কীভাবে সাহায্য করতে পারি?" : "How can I help today?"}
              </h1>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-ink-2">
                {mode === "agent"
                  ? "Describe the product or fix, then attach any existing project files. Nemotron 3 Ultra will create reviewable files you can preview and push to GitHub only after approval."
                  : locale === "bn"
                    ? "লেখা, শেখা, পরিকল্পনা, গবেষণা, প্রযুক্তি, কোডিং ও নিরাপদ ডিজিটাল সহায়তা—বাংলা, Banglish বা English-এ যেকোনো প্রশ্ন করুন।"
                    : "Ask about writing, learning, planning, research, technology, coding, or safe digital help. Attach the material when you want MATRIX to inspect something specific."}
              </p>
            </div>
            <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => {
                    if ("href" in s && s.href) router.push(s.href);
                    else if ("action" in s && s.action === "attach") fileRef.current?.click();
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
                      {m.metadata?.attachment_names?.length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
                          {m.metadata.attachment_names.map((name) => <span key={name} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 font-mono text-[10px] text-ink-2"><FileCode2 size={10} />{name}</span>)}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="border-l border-border pl-4">
                      <Markdown text={m.content} />
                      {m.metadata?.action === "theme_gallery" ? (
                        <div className="mt-3 rounded-xl border border-border bg-surface p-3">
                          <ThemeGallery compact />
                        </div>
                      ) : null}
                      {m.metadata?.artifacts?.length ? (
                        <button
                          type="button"
                          onClick={() => { setAgentFiles(m.metadata!.artifacts!); setAgentProjectId(m.metadata?.project_id ?? null); setWorkspaceOpen(true); }}
                          className="mt-3 flex w-full items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-3 text-left transition-colors hover:border-accent/60"
                        >
                          <span className="flex min-w-0 items-center gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-white"><MonitorPlay size={15} /></span><span><span className="block text-xs font-semibold text-ink">Open Agent workspace</span><span className="block text-[11px] text-ink-3">{m.metadata.artifacts.length} file{m.metadata.artifacts.length === 1 ? "" : "s"} · Live preview · GitHub push</span></span></span>
                          <span className="text-xs font-medium text-accent">Review</span>
                        </button>
                      ) : null}
                    </div>
                  )}
                  <div className={cn("mt-1.5 flex items-center gap-3 px-0.5 text-[10.5px] text-ink-3", m.role === "user" ? "justify-end" : "")}>
                    <span>{m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                    {m.role === "assistant" && m.metadata?.model ? (
                      <span className="hidden sm:inline">{m.metadata.model.includes("nemotron") ? "Nemotron 3 Ultra" : "MATRIX model"}</span>
                    ) : null}
                    {m.role === "assistant" ? (
                      <button
                        type="button"
                        onClick={() => copyMessage(m.content)}
                        className="min-h-8 min-w-8 font-medium uppercase tracking-wide transition-colors hover:text-ink-2"
                      >
                        Copy
                      </button>
                    ) : null}
                    {m.role === "assistant" && mode !== "agent" ? (
                      <ListenButton
                        speaking={speakingId === (m.id ?? `msg-${i}`) || (speakingId === "auto" && i === messages.length - 1)}
                        onClick={() => listenTo(m.id ?? `msg-${i}`, m.content)}
                        disabled={streaming}
                        listenLabel={t("chat.listen")}
                        stopLabel={t("chat.stopSpeech")}
                      />
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
        {attachments.length ? (
          <div className="mx-auto mb-2 flex max-w-2xl flex-wrap gap-1.5" aria-label="Attached files">
            {attachments.map((file) => (
              <span key={file.name} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2.5 pr-1 text-[11px] text-ink-2">
                <FileCode2 size={11} className="shrink-0" /><span className="truncate font-mono">{file.name}</span><span className="text-ink-3">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.name !== file.name))} className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-surface hover:text-danger" aria-label={`Remove ${file.name}`}><X size={11} /></button>
              </span>
            ))}
          </div>
        ) : null}
        <form
          onSubmit={(e) => void send(e)}
          className="mx-auto flex max-w-2xl items-end gap-1.5 rounded-xl border border-border-strong bg-surface p-1.5 shadow-[var(--shadow-card)] transition-colors focus-within:border-accent"
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,.txt,.md,.mdx,.json,.jsonc,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.html,.htm,.css,.scss,.sass,.less,.vue,.svelte,.sql,.graphql,.yaml,.yml,.toml,.xml,.env,.sh,.bash,.go,.rs,.java,.kt,.php,.rb,.swift,.dart,.c,.h,.cc,.cpp,.cs,Dockerfile,Makefile"
            className="sr-only"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={streaming}
            aria-label="Attach an image, document, or source-code file"
            title="Attach an image, document, or source-code file"
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
            <Button type="submit" disabled={!input.trim() && attachments.length === 0} className="h-11 shrink-0 !px-3.5" aria-label={t("chat.send")}>
              <Send size={15} strokeWidth={1.7} />
            </Button>
          )}
        </form>
        <div className="mx-auto mt-2 flex max-w-2xl items-center justify-between gap-2 px-1 pb-1">
          <p className="hidden text-[11px] text-ink-3 sm:block">{mode === "agent" ? "Agent may make mistakes · review files before preview or push" : "MATRIX may make mistakes · verify important information"}</p>
          <p className="text-[11px] text-ink-3 sm:hidden">{mode === "agent" ? "Review before preview or push" : "Verify important information"}</p>
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

      {mode === "agent" ? (
        <AgentWorkspace
          files={agentFiles}
          open={workspaceOpen}
          onClose={() => setWorkspaceOpen(false)}
          conversationId={convId}
          projectId={agentProjectId ?? undefined}
        />
      ) : null}
    </div>
  );
}
