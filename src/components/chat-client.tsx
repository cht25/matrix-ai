"use client";

// =============================================================================
// MATRIX chat — context-aware, intent-driven.
//
//   USER INTENT → CAPABILITY SELECTION → EXECUTION → CONTEXTUAL UI
//
// A normal conversation renders exactly four things: the user message, the
// Matrix reply, its contextual actions (Copy · Regenerate · More ▾) and the
// composer. Export, Agent execution, image generation, analytics and activity
// are real capabilities, but each one is mounted only when the user's intent
// (or the content of the reply) makes it relevant.
//
// Fakes-free contract: every assistant message comes from the real gateway.
// Any failure renders "Server problem" with a [Retry] — never a canned reply,
// never an endless loader, and never a simulated reasoning trace.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  BrainCircuit, Code2, Download, ExternalLink, FileSearch, Globe, GraduationCap, Image as ImageIcon,
  Lock, MonitorPlay, Paperclip, Play, RefreshCcw, Send, ShieldAlert, Sparkles, Square,
  WandSparkles, X, Zap,
} from "lucide-react";
import { AutoSpeakToggle } from "@/components/chat-speech-controls";
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
import { classifyGatewayResponse, classifyRequestException, failureCopy, withRequestReference, type ApiFailure } from "@/lib/api-errors";
import { useI18n } from "@/lib/i18n/client";
import { useIsCompact } from "@/lib/client/use-media-query";
import { cn } from "@/lib/utils";
import type { AgentFile, TextAttachment } from "@/lib/ai/agent";
import { modeMeta, suggestMode, type ChatMode, type ExplainStyle, type ModelLane, type ResponseStrategy, type StudyLevel } from "@/lib/ai/modes";
import {
  DEFAULT_INTENT, analyzeContent, availableExportFormats, classifyResponseKind, detectIntent,
  effectiveMode, planResponseActions, selectCapability, type ContentSignals, type ExportFormat,
  type IntentResult, type ResponseActionId,
} from "@/lib/ai/intent";
import {
  advanceExecution, beginArtifact, completeArtifact, emptyArtifactState, emptyExecution,
  failArtifact, finishExecution, fromSnapshot, pickArtifactContent, requestArtifact, startExecution,
  type ArtifactState, type ExecutionState,
} from "@/lib/ai/artifacts";
import { buildArtifact, extractJson, type BuiltArtifact } from "@/lib/export/response-export";
import { intentForMessage, latestArtifacts, latestProjectId, lastUserContent, messageKey, type ChatMessage, type MessageMetadata } from "@/lib/chat-messages";
import { ChatTopBar } from "@/components/chat-topbar";
import { AssistantMessage } from "@/components/assistant-message";
import { AgentWorkspace } from "@/components/agent-workspace";
import { AgentActivityCard } from "@/components/agent-sandbox";
import { ArtifactCard } from "@/components/artifact-panel";
import { ResponseProgress } from "@/components/response-status";
import { ModeQuickActions, LiveTaskGraph, type GraphNode } from "@/components/mode-workspace";
import { planOrchestrator } from "@/lib/ai/router";
import type { AgentStageId, PipelineAnalytics } from "@/lib/ai/pipeline";

export type { ChatMessage, MessageMetadata };

type PendingAttachment = TextAttachment & { size: number };

const CONNECT_TIMEOUT_MS = 25_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Formats a browser can open inline; the rest are download-only. */
const OPENABLE: ExportFormat[] = ["pdf", "markdown", "txt", "json", "csv"];

const SUGGESTIONS = [
  { icon: <Sparkles size={16} strokeWidth={1.6} />, label: "Plan or brainstorm", desc: "Turn an idea into steps", prompt: "Help me turn an idea into a clear step-by-step plan." },
  { icon: <BrainCircuit size={16} strokeWidth={1.6} />, label: "Explain something", desc: "Simple, with an example", prompt: "Explain a difficult topic simply, then give me a practical example." },
  { icon: <FileSearch size={16} strokeWidth={1.6} />, label: "Analyse a file or image", desc: "Inspect what you attach", prompt: null, action: "attach" },
  { icon: <Code2 size={16} strokeWidth={1.6} />, label: "Build with Agent", desc: "Preview and push code", prompt: null, href: "/chat?mode=agent" },
  { icon: <ShieldAlert size={16} strokeWidth={1.6} />, label: "Check something suspicious", desc: "Links, messages, scams", prompt: "Help me check whether a message, link or situation is suspicious." },
  { icon: <GraduationCap size={16} strokeWidth={1.6} />, label: "Learn a new skill", desc: "A short beginner lesson", prompt: "Help me learn a useful new skill with a short beginner lesson and an exercise." },
];

const FEATURES = [
  { icon: <Zap size={14} strokeWidth={1.7} />, title: "Smart & Fast", desc: "Answers in seconds" },
  { icon: <Lock size={14} strokeWidth={1.7} />, title: "Secure & Private", desc: "Your data stays yours" },
  { icon: <WandSparkles size={14} strokeWidth={1.7} />, title: "Multi-Model AI", desc: "Automatic routing" },
  { icon: <ImageIcon size={14} strokeWidth={1.7} />, title: "File & Image Support", desc: "Drop in what you need" },
];

const AGENT_SUGGESTIONS = [
  { icon: <Code2 size={15} strokeWidth={1.5} />, label: "Build a responsive website", prompt: "Build a polished responsive website from my description. Start by asking only for the one most important missing requirement." },
  { icon: <FileSearch size={15} strokeWidth={1.5} />, label: "Fix an attached project", prompt: "Review the attached project files, identify the root cause, and return complete corrected files." },
  { icon: <MonitorPlay size={15} strokeWidth={1.5} />, label: "Create a live prototype", prompt: "Create a self-contained HTML, CSS and JavaScript prototype that I can open in Live Preview." },
  { icon: <Code2 size={15} strokeWidth={1.5} />, label: "Prepare a GitHub change", prompt: "Prepare a focused, production-ready code change with complete files and a verification checklist." },
];

async function parseErrorCode(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === "string" ? data.error : null;
  } catch {
    return null;
  }
}

async function parseGatewayError(res: Response): Promise<{ code: string | null; conversationId: string | null; requestId: string | null }> {
  try {
    const data = (await res.json()) as { error?: unknown; conversation_id?: unknown };
    return {
      code: typeof data.error === "string" ? data.error : null,
      conversationId: typeof data.conversation_id === "string" ? data.conversation_id : null,
      requestId: res.headers.get("X-MATRIX-Request-ID"),
    };
  } catch {
    // Non-JSON error body (proxy/host interstitial) — still surface the id.
    return { code: null, conversationId: null, requestId: res.headers.get("X-MATRIX-Request-ID") };
  }
}

/** The most recent assistant answer before the current turn. */
function lastAssistantContent(list: ChatMessage[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "assistant" && list[i].content.trim()) return list[i].content;
  }
  return null;
}

function firstHeading(content: string, fallback: string): string {
  const heading = content.match(/^#{1,4}\s+(.+)$/m)?.[1]?.trim();
  const line = (heading ?? content.trim().split("\n")[0] ?? "").replace(/[#*_`]/g, "").trim();
  return (line || fallback).slice(0, 60);
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
  const compact = useIsCompact();

  // --- conversation -------------------------------------------------------
  const [mode, setMode] = useState<ChatMode>(isTemporary ? "general" : initialMode);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [convId, setConvId] = useState<string | null>(initialConvId);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(lastUserContent(initialMessages));
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  // --- capability selection (secondary; lives in the top bar / settings) ---
  const [lane, setLane] = useState<ModelLane>("auto");
  const [strategy, setStrategy] = useState<ResponseStrategy>("balanced");
  const [studyLevel, setStudyLevel] = useState<StudyLevel>("college");
  const [explainStyle, setExplainStyle] = useState<ExplainStyle>("simple");
  const [demoMode, setDemoMode] = useState(false);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [modeHint, setModeHint] = useState<ChatMode | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [codeHint, setCodeHint] = useState(false);

  // --- run state ----------------------------------------------------------
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [activeStartedAt, setActiveStartedAt] = useState<number | null>(null);
  const [runMode, setRunMode] = useState<ChatMode>(mode);
  const [runIntent, setRunIntent] = useState<IntentResult>(DEFAULT_INTENT);

  // --- intent-driven UI state (spec §27) ----------------------------------
  /** Execution detail for the current/last run. Empty for plain chat. */
  const [execution, setExecution] = useState<ExecutionState>(emptyExecution());
  /** Artifact lifecycle per message key. Absent = Not Requested. */
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactState>>({});
  /** Which message has the inline "Export as" row open (More ▾ → Export). */
  const [exportPickerKey, setExportPickerKey] = useState<string | null>(null);

  // --- agent workspace ----------------------------------------------------
  const [agentFiles, setAgentFiles] = useState<AgentFile[]>(latestArtifacts(initialMessages));
  const [agentProjectId, setAgentProjectId] = useState<string | null>(latestProjectId(initialMessages));
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  // --- routing metadata (tertiary) ---------------------------------------
  const [lastModel, setLastModel] = useState<string | null>(() => {
    for (let i = initialMessages.length - 1; i >= 0; i--) if (initialMessages[i].metadata?.model) return initialMessages[i].metadata!.model!;
    return null;
  });
  const [lastProvider, setLastProvider] = useState<string | null>(() => {
    for (let i = initialMessages.length - 1; i >= 0; i--) if (initialMessages[i].metadata?.provider) return initialMessages[i].metadata!.provider!;
    return null;
  });

  // --- speech -------------------------------------------------------------
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // State updates are batched; this synchronous guard prevents a fast Enter +
  // form-submit/click sequence from creating two provider requests.
  const requestInFlightRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const convIdRef = useRef<string | null>(initialConvId);
  /** Latest committed conversation, read while a request is in flight. */
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  const lastAttachmentsRef = useRef<PendingAttachment[]>([]);
  const autoSpeakRef = useRef(true);
  const localeRef = useRef(locale);
  /** Built artifacts, kept so Open/Save never rebuilds twice. */
  const builtRef = useRef<Map<string, BuiltArtifact>>(new Map());
  /** Prompt text behind an image reply, for [Edit prompt]. */
  const imagePromptRef = useRef<string | null>(null);

  const suggestions = mode === "agent" ? AGENT_SUGGESTIONS : locale === "bn" ? [
    { icon: <Sparkles size={15} strokeWidth={1.5} />, label: "পরিকল্পনা বা আইডিয়া", prompt: "আমার একটি আইডিয়াকে পরিষ্কার ধাপে ধাপে পরিকল্পনায় সাজাতে সাহায্য করুন।" },
    { icon: <BrainCircuit size={15} strokeWidth={1.5} />, label: "সহজভাবে বুঝিয়ে দিন", prompt: "একটি কঠিন বিষয় সহজভাবে বুঝিয়ে একটি বাস্তব উদাহরণ দিন।" },
    { icon: <FileSearch size={15} strokeWidth={1.5} />, label: "ফাইল বা ছবি বিশ্লেষণ", prompt: null, action: "attach" },
    { icon: <Code2 size={15} strokeWidth={1.5} />, label: "Agent দিয়ে তৈরি করুন", prompt: null, href: "/chat?mode=agent" },
  ] : SUGGESTIONS;

  useEffect(() => { convIdRef.current = convId; }, [convId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    const preferred = readAutoSpeakPreference(true);
    setAutoSpeak(preferred);
    autoSpeakRef.current = preferred;
  }, []);

  useEffect(() => { autoSpeakRef.current = autoSpeak; }, [autoSpeak]);
  useEffect(() => { localeRef.current = locale; }, [locale]);

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

  // Restore an explicitly requested artifact for the latest exchange after a
  // reload. Only the last turn — history never grows artifact panels.
  useEffect(() => {
    if (!initialMessages.length) return;
    let assistantIndex = -1;
    for (let i = initialMessages.length - 1; i >= 0; i--) {
      if (initialMessages[i].role === "assistant") { assistantIndex = i; break; }
    }
    if (assistantIndex < 0) return;
    const message = initialMessages[assistantIndex];
    if (message.metadata?.artifact) {
      setArtifacts({ [messageKey(message, assistantIndex)]: fromSnapshot(message.metadata.artifact) });
      return;
    }
    const intent = intentForMessage(initialMessages, assistantIndex);
    if (!intent.artifactRequested || intent.artifact === "NONE" || !intent.formats.length) return;
    setArtifacts({
      [messageKey(message, assistantIndex)]: requestArtifact(emptyArtifactState(), {
        format: intent.formats[0],
        title: firstHeading(message.content, "MATRIX response"),
      }),
    });
    // Runs once per mounted conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Content signals per message — recomputed only when messages change. */
  const signalsByIndex = useMemo<(ContentSignals | null)[]>(
    () => messages.map((message) => (message.role === "assistant" ? analyzeContent(message.content) : null)),
    [messages],
  );

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
    setExecution(emptyExecution());
    setArtifacts({});
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

  // -------------------------------------------------------------------------
  // Artifacts — real builds, only after a request
  // -------------------------------------------------------------------------

  function updateArtifact(key: string, next: (current: ArtifactState) => ArtifactState) {
    setArtifacts((current) => ({ ...current, [key]: next(current[key] ?? emptyArtifactState()) }));
  }

  /** Requested → Generating → Ready (or Failed) for one message. */
  function buildArtifactFor(key: string, format: ExportFormat, content: string, title: string) {
    updateArtifact(key, (current) => beginArtifact(requestArtifact(current, { format, title })));
    // One frame later so the "Generating…" state is real, not skipped.
    window.setTimeout(() => {
      try {
        const built = buildArtifact(format, content, title);
        if (!built) {
          updateArtifact(key, (current) =>
            failArtifact(current, format === "csv" || format === "xlsx"
              ? "This answer has no tabular data to export yet."
              : "There is nothing to export in this answer yet."),
          );
          return;
        }
        builtRef.current.set(key, built);
        updateArtifact(key, (current) => completeArtifact(current, built.filename));
      } catch {
        updateArtifact(key, (current) => failArtifact(current, "The file could not be built. Try again."));
      }
    }, 80);
  }

  function artifactSource(key: string, content: string, title: string, format: ExportFormat) {
    const cached = builtRef.current.get(key);
    if (cached && cached.filename.endsWith(`.${format === "markdown" ? "md" : format}`)) return cached;
    const built = buildArtifact(format, content, title);
    if (built) builtRef.current.set(key, built);
    return built;
  }

  function downloadBuilt(key: string, content: string, title: string, format: ExportFormat) {
    const built = artifactSource(key, content, title, format);
    if (!built) {
      toast("Nothing to download yet");
      return;
    }
    const url = URL.createObjectURL(new Blob([built.data], { type: built.mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = built.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(`${format.toUpperCase()} saved`);
  }

  function openBuilt(key: string, content: string, title: string, format: ExportFormat) {
    const built = artifactSource(key, content, title, format);
    if (!built) {
      toast("Nothing to open yet");
      return;
    }
    const url = URL.createObjectURL(new Blob([built.data], { type: built.mime }));
    const tab = window.open(url, "_blank", "noopener,noreferrer");
    if (!tab) toast("Allow pop-ups to open this file");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function saveDataUrl(dataUrl: string, filename: string) {
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = filename;
    anchor.click();
    toast("Image saved");
  }

  function requestArtifactFromIntent(key: string, intent: IntentResult, reply: string) {
    if (!intent.artifactRequested || intent.suppressExport) return;
    if (intent.artifact === "IMAGE") {
      // The image itself arrives with the reply; mark the artifact ready.
      updateArtifact(key, (current) =>
        completeArtifact(beginArtifact(requestArtifact(current, { type: "IMAGE", title: "Matrix image" })), "matrix-image.png"),
      );
      return;
    }
    const format = intent.formats[0];
    if (!format) return;
    // "Turn THIS answer into a PDF" refers to the previous answer; "create a
    // CSV from this table" refers to the table in the reply that just arrived.
    const previous = lastAssistantContent(messagesRef.current);
    const content = pickArtifactContent({ format, reply, previous });
    buildArtifactFor(key, format, content, firstHeading(content, "MATRIX response"));
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  function commitPartial(
    text: string,
    opts: { replaceLastAssistant?: boolean; turnId?: string; intent?: IntentResult } = {},
    metadata: MessageMetadata = {},
  ) {
    const reply = text.trim();
    if (!reply) return null;
    if (metadata.model) setLastModel(metadata.model);
    if (metadata.provider) setLastProvider(metadata.provider);
    if (metadata.project_id) setAgentProjectId(metadata.project_id);
    if (metadata.duration_ms === undefined && activeStartedAt) metadata.duration_ms = Date.now() - activeStartedAt;
    if (opts.turnId) metadata.turn_id = opts.turnId;
    if (opts.intent) {
      metadata.intent = opts.intent.intent;
      metadata.artifact_type = opts.intent.artifact;
    }
    if (metadata.artifacts?.length) {
      setAgentFiles(metadata.artifacts);
      // The workspace no longer pops open over the finished answer — the
      // contextual "Open Agent workspace" card and the top-bar button do that.
    }
    const key = `t:${opts.turnId ?? crypto.randomUUID()}`;
    setMessages((current) => {
      const base = opts.replaceLastAssistant && current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current;
      const last = base[base.length - 1];
      if (last?.role === "assistant" && last.content === reply) {
        // Identical reply (a retry that produced the same text): keep one
        // message but stamp this turn's metadata so its key still matches the
        // artifact/execution state built for it.
        return [...base.slice(0, -1), { ...last, metadata: { ...last.metadata, ...metadata } }];
      }
      return [...base, { role: "assistant", content: reply, created_at: new Date().toISOString(), metadata }];
    });
    return key;
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

  async function streamMessage(
    message: string,
    opts: {
      replaceLastAssistant?: boolean;
      reuseUser?: boolean;
      regenerate?: boolean;
      preferFallback?: boolean;
      attachments?: PendingAttachment[];
      intent?: IntentResult;
      turnId?: string;
    } = {},
  ) {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const replaceLastAssistant = opts.replaceLastAssistant === true;
    const sentAttachments = opts.attachments ?? [];
    const turnId = opts.turnId ?? crypto.randomUUID();

    // --- intent detection → capability selection -------------------------
    const intent = opts.intent ?? detectIntent(message, { mode, codeCapability: codeHint, agentMode: mode === "agent" });
    const capability = selectCapability(intent, mode);
    const messageMode = effectiveMode(intent, mode);
    const isImage = capability === "image";
    const isOrchestrator = capability === "orchestrate";
    const isAgentRun = capability === "agent";
    // Plain chat keeps no execution trace at all: no activity, no analytics.
    const trackExecution = isAgentRun || isImage || isOrchestrator || demoMode;

    setFailure(null);
    setNotice(null);
    setStreaming(true);
    setRunIntent(intent);
    setRunMode(messageMode);
    setStreamStatus("connecting");
    setLastUserMessage(message);
    if (isImage) imagePromptRef.current = message;
    const startedAt = Date.now();
    setActiveStartedAt(startedAt);
    setActiveModel(lastModel);
    setStreamedText("");
    setExportPickerKey(null);
    if (replaceLastAssistant) {
      builtRef.current.clear();
      setArtifacts({});
    }
    setExecution(
      trackExecution
        ? startExecution(emptyExecution(), isAgentRun ? "Agent initialized" : isImage ? "Image generation started" : "Connecting")
        : emptyExecution(),
    );
    stopSpeech();
    setSpeakingId(null);
    if (!isAgentRun && autoSpeakRef.current) primeSpeech();

    if (!firebaseBrowserConfigured) {
      setFailure({ ...failureCopy("not-configured"), detail: "The MATRIX backend is not configured on this deployment yet, so chat cannot start." });
      setStreaming(false);
      setStreamedText(null);
      requestInFlightRef.current = false;
      return;
    }

    // Session cookie authenticates /api/ai — do NOT require Firebase currentUser
    // (it is often still null for a beat after a refresh, which used to fail every send).
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = crypto.randomUUID();
    let collected = "";
    let committed = false;
    let committedKey: string | null = null;
    const streamMetadata: MessageMetadata = {};

    const commit = (text: string) => {
      const key = commitPartial(text, { replaceLastAssistant, turnId, intent }, streamMetadata);
      if (key) committedKey = key;
      committed = true;
      // An artifact the user explicitly asked for is built once the reply lands.
      if (key && !isImage) requestArtifactFromIntent(key, intent, text);
      if (key && isImage && streamMetadata.image_data_url) {
        updateArtifact(key, (current) =>
          completeArtifact(beginArtifact(requestArtifact(current, { type: "IMAGE", title: "Matrix image" })), "matrix-image.png"),
        );
      }
    };

    try {
      armIdleTimer(isAgentRun ? 180_000 : CONNECT_TIMEOUT_MS, controller);
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: isImage ? "image" : isOrchestrator ? "orchestrate" : "chat",
          stream: !isImage && !isOrchestrator,
          conversation_id: convIdRef.current,
          is_temporary: isTemporary,
          mode: messageMode,
          lane,
          strategy,
          study_level: studyLevel,
          explain_style: explainStyle,
          message,
          attachments: sentAttachments.map(({ name, content, type }) => ({ name, content, type })),
          language: locale,
          regenerate: opts.regenerate === true,
          reuse_user: opts.reuseUser === true || opts.regenerate === true,
          prefer_fallback: opts.preferFallback === true,
          request_id: requestId,
        }),
        signal: controller.signal,
      });
      armIdleTimer(STREAM_IDLE_TIMEOUT_MS, controller);

      if (!res.ok) {
        clearIdleTimer();
        const gatewayError = await parseGatewayError(res);
        if (gatewayError.conversationId) rememberConv(gatewayError.conversationId);
        setFailure(withRequestReference(classifyGatewayResponse(res.status, gatewayError.code), gatewayError.requestId));
        if (trackExecution) setExecution((current) => finishExecution(advanceExecution(current, { event: { at: Date.now(), type: "error", message: "Request failed" } }), "failed"));
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
          provider?: string;
          fallback?: boolean;
          theme_gallery?: boolean;
          storage_degraded?: boolean;
          image?: { data_url?: string };
          analytics?: PipelineAnalytics;
          tasks?: Array<{ id: string; title: string; error?: string; image_data_url?: string }>;
        };
        if (trackExecution && data.analytics) setExecution((current) => advanceExecution(current, { analytics: data.analytics! }));
        if (data.tasks) {
          setGraphNodes(data.tasks.map((task) => ({ id: task.id, title: task.title, status: task.error ? "failed" : "completed" })));
        }
        if (data.conversation_id) rememberConv(data.conversation_id);
        if (data.project_id) setAgentProjectId(data.project_id);
        if (data.model) setActiveModel(data.model);

        if (data.image?.data_url) {
          streamMetadata.mode = "image";
          streamMetadata.image_data_url = data.image.data_url;
          streamMetadata.model = data.model;
          streamMetadata.provider = data.provider ?? "Together";
          commit(data.reply || "Image ready.");
          if (trackExecution) setExecution((current) => finishExecution(advanceExecution(current, { event: { at: Date.now(), type: "complete", message: "Response ready" } }), "complete"));
          setStreamStatus("complete");
          return;
        }

        if (data.reply) {
          streamMetadata.artifacts = data.files;
          streamMetadata.project_id = data.project_id ?? undefined;
          streamMetadata.model = data.model;
          streamMetadata.mode = data.mode;
          streamMetadata.coding_detected = data.coding_detected;
          streamMetadata.provider = data.provider;
          streamMetadata.fallback = data.fallback;
          streamMetadata.action = data.theme_gallery ? "theme_gallery" : undefined;
          commit(data.reply);
          maybeAutoSpeak(data.reply);
          if (data.storage_degraded) setNotice("The assistant replied, but the chat could not be saved to storage right now.");
          if (trackExecution) setExecution((current) => finishExecution(advanceExecution(current, { event: { at: Date.now(), type: "complete", message: "Response ready" } }), "complete"));
          // Update the URL to the conversation WITHOUT triggering a full Next.js
          // navigation: router.replace here would unmount ChatClient and discard
          // the state updates from commitPartial. history.replaceState keeps the
          // component mounted so the result is visible immediately.
          if (data.conversation_id && !isTemporary) {
            const targetUrl = `/chat/${data.conversation_id}`;
            if (!window.location.pathname.startsWith(targetUrl)) window.history.replaceState(null, "", targetUrl);
          }
          return;
        }
        setFailure(withRequestReference(failureCopy("server"), res.headers.get("X-MATRIX-Request-ID")));
        return;
      }

      const sseRequestId = res.headers.get("X-MATRIX-Request-ID");
      const reader = res.body?.getReader();
      if (!reader) {
        clearIdleTimer();
        setFailure(withRequestReference(failureCopy("server"), res.headers.get("X-MATRIX-Request-ID")));
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;
      let gotConversationId: string | null = null;

      type StreamEvent = {
        delta?: string;
        done?: boolean;
        conversation_id?: string;
        error?: string;
        model?: string;
        mode?: ChatMode;
        coding_detected?: boolean;
        provider?: string;
        fallback?: boolean;
        storage_degraded?: boolean;
        stage?: AgentStageId;
        label?: string;
        tool?: string;
        stream_status?: string;
        files?: AgentFile[];
        project_id?: string | null;
        analytics?: PipelineAnalytics;
      };

      const handleEvent = (data: StreamEvent) => {
        if (data.stream_status) setStreamStatus(data.stream_status);
        if (trackExecution && data.stage) {
          setExecution((current) =>
            advanceExecution(current, {
              stage: data.stage!,
              event: { at: Date.now(), type: "stage", message: data.label || data.stage!, stage: data.stage },
            }),
          );
        }
        if (trackExecution && data.tool) {
          setExecution((current) =>
            advanceExecution(current, { tool: data.tool!, event: { at: Date.now(), type: "tool", message: "Tool selected", tool: data.tool } }),
          );
        }
        if (trackExecution && data.analytics) setExecution((current) => advanceExecution(current, { analytics: data.analytics! }));
        if (data.files?.length) streamMetadata.artifacts = data.files;
        if (data.project_id) streamMetadata.project_id = data.project_id;
        if (data.model) { streamMetadata.model = data.model; setActiveModel(data.model); }
        if (data.mode) streamMetadata.mode = data.mode;
        if (typeof data.coding_detected === "boolean") streamMetadata.coding_detected = data.coding_detected;
        if (data.provider) streamMetadata.provider = data.provider;
        if (typeof data.fallback === "boolean") streamMetadata.fallback = data.fallback;
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
          commit(collected);
          maybeAutoSpeak(collected);
          if (data.storage_degraded) setNotice("The assistant replied, but the chat could not be saved to storage right now.");
        }
      };

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
            handleEvent(JSON.parse(line.slice(5).trim()) as StreamEvent);
          } catch {
            // malformed event — skip
          }
        }
      }
      // A proxy or provider may close immediately after a final SSE line without
      // the usual blank delimiter. Consume that final buffered event instead of
      // silently dropping the last delta/error.
      if (buffer.trim().startsWith("data:")) {
        try {
          handleEvent(JSON.parse(buffer.trim().slice(5).trim()) as StreamEvent);
        } catch {
          // Keep the partial response; the backend logs the malformed event.
        }
      }
      clearIdleTimer();

      if (!committed && collected.trim()) {
        commit(collected);
        maybeAutoSpeak(collected);
      }
      if (trackExecution) {
        setExecution((current) => finishExecution(current, streamError && !collected.trim() ? "failed" : "complete"));
      }
      if (streamError) {
        if (!collected.trim()) {
          setFailure(withRequestReference(
            streamError === "STREAM_FAILED"
              ? { ...failureCopy("server"), detail: "The response was interrupted. Your message is safe — try again." }
              : classifyGatewayResponse(502, streamError),
            sseRequestId,
          ));
          return;
        }
        setNotice("The response was interrupted after a partial answer. You can retry safely.");
      }
      if (gotConversationId && !isTemporary && !initialConvId) {
        // Same reasoning as above: keep the component mounted so the streamed
        // reply and its artifact state stay visible.
        const targetUrl = `/chat/${gotConversationId}`;
        if (!window.location.pathname.startsWith(targetUrl)) window.history.replaceState(null, "", targetUrl);
      }
    } catch (err) {
      clearIdleTimer();
      const userStopped = err instanceof DOMException && err.name === "AbortError";
      if (collected.trim() && !committed) {
        commit(collected);
      }
      if (userStopped) {
        setNotice(collected.trim() ? "Generation stopped." : "Generation stopped. Your message is safe.");
        if (trackExecution) setExecution((current) => finishExecution(current, "failed"));
      } else {
        setFailure(classifyRequestException(err));
        if (trackExecution) setExecution((current) => finishExecution(advanceExecution(current, { event: { at: Date.now(), type: "error", message: "Request failed" } }), "failed"));
      }
      if (committedKey) {
        // An artifact can never be left "generating" after a failed run.
        updateArtifact(committedKey, (current) => (current.status === "generating" || current.status === "requested" ? failArtifact(current, "The response did not finish.") : current));
      }
    } finally {
      clearIdleTimer();
      setStreaming(false);
      setStreamedText(null);
      setActiveStartedAt(null);
      abortRef.current = null;
      requestInFlightRef.current = false;
      setStreamStatus(null);
    }
  }

  async function send(e?: { preventDefault(): void }, messageOverride?: string) {
    e?.preventDefault();
    const pending = messageOverride ? [] : attachments;
    let message = (messageOverride ?? input).trim() || (pending.length ? "Review these attached files and help me with them." : "");
    if (!message || streaming || requestInFlightRef.current) return;
    // Composer capabilities are opt-in hints, never automatic invocations.
    const rawMessage = message;
    if (!messageOverride) {
      if (webSearch) message = `Use up-to-date public knowledge where it helps.\n\n${message}`;
      if (codeHint) message = `Answer with complete, runnable code when it helps.\n\n${message}`;
    }
    setInput("");
    lastAttachmentsRef.current = pending;
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // --- intent detection happens on the user's own words -----------------
    const intent = detectIntent(rawMessage, {
      mode,
      codeCapability: codeHint || mode === "code",
      agentMode: mode === "agent",
    });
    const turnId = crypto.randomUUID();
    setMessages((current) => [...current, {
      role: "user",
      content: message,
      created_at: new Date().toISOString(),
      metadata: {
        mode,
        attachment_names: pending.map((file) => file.name),
        intent: intent.intent,
        artifact_type: intent.artifact,
        turn_id: turnId,
      },
    }]);
    const hinted = suggestMode(rawMessage, mode);
    if (hinted && hinted !== effectiveMode(intent, mode)) setModeHint(hinted);
    if (mode === "orchestrator") setGraphNodes(planOrchestrator(rawMessage).map((task) => ({ id: task.id, title: task.title, status: "running" as const })));
    await streamMessage(message, { attachments: pending, intent, turnId });
  }

  function regenerate() {
    if (!lastUserMessage || streaming) return;
    void streamMessage(lastUserMessage, {
      replaceLastAssistant: true,
      regenerate: true,
      reuseUser: true,
      attachments: lastAttachmentsRef.current,
    });
  }

  function retry() {
    if (!lastUserMessage || streaming) return;
    setFailure(null);
    const hasUser = messages.some((message) => message.role === "user" && message.content === lastUserMessage);
    if (!hasUser) {
      const msg = lastUserMessage;
      setMessages((current) => [...current, { role: "user", content: msg, created_at: new Date().toISOString() }]);
    }
    void streamMessage(lastUserMessage, { reuseUser: Boolean(convIdRef.current), attachments: lastAttachmentsRef.current });
  }

  function tryAnotherModel() {
    if (!lastUserMessage || streaming || requestInFlightRef.current) return;
    setFailure(null);
    const hasUser = messages.some((message) => message.role === "user" && message.content === lastUserMessage);
    if (!hasUser) {
      setMessages((current) => [...current, { role: "user", content: lastUserMessage, created_at: new Date().toISOString() }]);
    }
    void streamMessage(lastUserMessage, {
      reuseUser: Boolean(convIdRef.current),
      preferFallback: true,
      attachments: lastAttachmentsRef.current,
    });
  }

  /** Follow-up prompt used by contextual actions (Explain, Sources, …). */
  function askFollowUp(prompt: string) {
    if (streaming) return;
    void send(undefined, prompt);
  }

  async function handleFile(file: File | undefined | null) {
    if (!file || streaming) return;
    setFailure(null);
    if (fileRef.current) fileRef.current.value = "";
    if (imageRef.current) imageRef.current.value = "";
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
      setMessages((current) => [...current, { role: "user", content: `Attachment: ${file.name}`, created_at: new Date().toISOString() }]);
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
        setMessages((current) => [...current, { role: "assistant", content: data.reply!, created_at: new Date().toISOString() }]);
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

  // -------------------------------------------------------------------------
  // Contextual actions (spec §15/§16) — built per reply, never all at once
  // -------------------------------------------------------------------------

  const actionRegistry = (index: number, message: ChatMessage, signals: ContentSignals, intent: IntentResult, artifact: ArtifactState) => {
    const key = messageKey(message, index);
    const title = firstHeading(message.content, "MATRIX response");
    const canRun = Boolean(agentFiles.length || agentProjectId);
    const handlers: Partial<Record<ResponseActionId, () => void>> = {
      copy: () => copyMessage(message.content),
      regenerate: () => regenerate(),
      copyCode: () => {
        const block = message.content.match(/```[^\n]*\n([\s\S]*?)```/);
        copyMessage(block ? block[1].trim() : message.content);
      },
      run: () => setWorkspaceOpen(true),
      explain: () => askFollowUp("Explain the code above step by step, then list what could go wrong."),
      save: () => {
        if (message.metadata?.image_data_url) saveDataUrl(message.metadata.image_data_url, `matrix-image-${key.slice(-6)}.png`);
        else if (artifact.format) downloadBuilt(key, message.content, title, artifact.format);
      },
      editPrompt: () => {
        const prompt = imagePromptRef.current ?? lastUserMessage ?? "";
        setInput(prompt);
        textareaRef.current?.focus();
        requestAnimationFrame(autosize);
      },
      sources: () => askFollowUp("List the sources and evidence behind that answer, and mark anything you could not verify."),
      export: () => setExportPickerKey((current) => (current === key ? null : key)),
      open: () => artifact.format && openBuilt(key, message.content, title, artifact.format),
      copyJson: () => copyMessage(extractJson(message.content) ?? message.content),
      listen: () => listenTo(key, message.content, index === latestAssistantIndex),
      workspace: () => setWorkspaceOpen(true),
      report: () => router.push("/report"),
      flashcards: () => askFollowUp("Turn the answer above into 8 flashcards in this format:\nQ: ...\nA: ..."),
    };
    const labels: Record<ResponseActionId, { label: string; icon?: ReactNode }> = {
      copy: { label: "Copy" },
      regenerate: { label: "Regenerate", icon: <RefreshCcw size={11} strokeWidth={1.8} /> },
      listen: { label: speakingId === key || speakingId === "auto" ? t("chat.stopSpeech") : t("chat.listen") },
      more: { label: "More" },
      copyCode: { label: "Copy code" },
      run: { label: "Run", icon: <Play size={11} strokeWidth={1.8} /> },
      explain: { label: "Explain" },
      save: { label: "Save", icon: <Download size={11} strokeWidth={1.8} /> },
      editPrompt: { label: "Edit prompt" },
      sources: { label: "Sources" },
      export: { label: "Export" },
      open: { label: "Open", icon: <ExternalLink size={11} strokeWidth={1.8} /> },
      copyJson: { label: "Copy JSON" },
      activity: { label: "Activity" },
      performance: { label: "Performance" },
      flashcards: { label: "Make flashcards" },
      workspace: { label: "Open workspace", icon: <MonitorPlay size={11} strokeWidth={1.8} /> },
      report: { label: "Report a problem" },
    };

    const plan = planResponseActions({
      intent: intent.intent,
      mode: (message.metadata?.mode ?? mode) as ChatMode,
      signals,
      artifactType: artifact.requested ? artifact.type : intent.artifact,
      artifactReady: artifact.status === "ready",
      artifactOpenable: artifact.format ? OPENABLE.includes(artifact.format) : true,
      hasExecution: execution.status !== "idle" && index === latestAssistantIndex,
      hasAnalytics: execution.analytics !== null && index === latestAssistantIndex,
      canRun,
      canListen: mode !== "agent" && !message.metadata?.image_data_url,
      canExport: !intent.suppressExport && Boolean(message.content.trim()),
      compact,
    });

    const build = (ids: ResponseActionId[]) =>
      ids
        .filter((id) => id !== "more" && id !== "activity" && id !== "performance")
        .map((id) => ({
          id: `${key}-${id}`,
          label: labels[id].label,
          icon: labels[id].icon,
          onClick: handlers[id] ?? (() => {}),
          disabled: id === "regenerate" ? streaming : false,
        }));

    return { primary: build(plan.primary), overflow: build(plan.overflow) };
  };

  const routingLabel = lastProvider || lastModel ? [lastProvider, lastModel].filter(Boolean).join(" · ") : null;
  const latestAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  }, [messages]);
  const latestSignals = latestAssistantIndex >= 0 ? signalsByIndex[latestAssistantIndex] : null;
  const imageRun = streaming && runIntent.intent === "IMAGE_GENERATION";

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}>
      {!isTemporary ? (
        <ChatTopBar
          mode={mode}
          onModeChange={switchMode}
          lane={lane}
          onLaneChange={setLane}
          strategy={strategy}
          onStrategyChange={setStrategy}
          streaming={streaming}
          autoSpeak={autoSpeak}
          onToggleAutoSpeak={toggleAutoSpeak}
          demoMode={demoMode}
          onToggleDemo={() => setDemoMode((value) => !value)}
          routingLabel={routingLabel}
          workspaceCount={mode === "agent" ? agentFiles.length : 0}
          onOpenWorkspace={() => setWorkspaceOpen(true)}
          autoSpeakLabels={{ on: t("chat.autoSpeakOn"), off: t("chat.autoSpeakOff") }}
        />
      ) : (
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3 border-b border-border pb-3 text-[13px] text-ink-2">
          <p><span className="eyebrow">Temporary</span> — {t("chat.tempNotice").replace(/^Temporary Chat — /, "")}</p>
          <AutoSpeakToggle on={autoSpeak} onToggle={toggleAutoSpeak} onLabel={t("chat.autoSpeakOn")} offLabel={t("chat.autoSpeakOff")} />
        </div>
      )}

      <div className="no-scrollbar min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-0.5 py-2 sm:px-2">
        {messages.length === 0 && !streaming ? (
          <div className="flex flex-col items-center px-1 py-6 text-center sm:py-8">
            <div className="mb-5">
              <span className="mb-3 inline-block" aria-hidden="true">
                <MatrixWordmark className="h-10 w-40 sm:h-12 sm:w-48" />
              </span>
              <h1 className="text-[22px] font-semibold tracking-tight text-ink sm:text-[28px]">
                {mode === "agent" ? "What should we build?" : locale === "bn" ? "আজ কীভাবে সাহায্য করতে পারি?" : "How can I help today?"}
              </h1>
              <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink-2 sm:text-sm">
                {mode === "agent"
                  ? "Describe the product or fix, then attach any existing project files. Review before preview or push."
                  : locale === "bn"
                    ? "লেখা, শেখা, পরিকল্পনা, গবেষণা, কোডিং ও নিরাপদ ডিজিটাল সহায়তা।"
                    : "Ask about writing, learning, planning, research, coding, or safe digital help."}
              </p>
            </div>
            {mode !== "agent" ? (
              <div className="mb-5 hidden w-full max-w-2xl grid-cols-2 gap-2 sm:grid lg:grid-cols-4">
                {FEATURES.map((feature) => (
                  <div key={feature.title} className="rounded-[16px] border border-border bg-surface px-3 py-3 text-left">
                    <span className="text-accent">{feature.icon}</span>
                    <p className="mt-2 text-[13px] font-medium text-ink">{feature.title}</p>
                    <p className="mt-0.5 text-[11px] text-ink-3">{feature.desc}</p>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="no-scrollbar grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  onClick={() => {
                    if ("href" in suggestion && suggestion.href) router.push(suggestion.href);
                    else if ("action" in suggestion && suggestion.action === "attach") fileRef.current?.click();
                    else if (suggestion.prompt) void send(undefined, suggestion.prompt);
                  }}
                  className="suggest-card"
                >
                  <span className="mt-0.5 text-accent" aria-hidden="true">{suggestion.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{suggestion.label}</span>
                    {"desc" in suggestion && suggestion.desc ? <span className="mt-0.5 block text-[11px] text-ink-3">{suggestion.desc}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message, index) => {
              const key = messageKey(message, index);
              if (message.role === "user") {
                return (
                  <div key={key} className="msg-in flex justify-end gap-3.5">
                    <div className="min-w-0 max-w-[88%] sm:max-w-[75%]">
                      <div className="rounded-[16px] border border-border bg-surface-2 px-4 py-2.5 text-[14.5px] leading-relaxed text-ink">
                        <p className="whitespace-pre-wrap break-words">{message.content}</p>
                        {message.metadata?.attachment_names?.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
                            {message.metadata.attachment_names.map((name) => (
                              <span key={name} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 font-mono text-[10px] text-ink-2">
                                <Code2 size={10} aria-hidden="true" />{name}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-1.5 flex justify-end px-0.5">
                        <span className="font-mono text-[10px] text-ink-3">
                          {message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }

              const signals = signalsByIndex[index] ?? analyzeContent(message.content);
              const intent = intentForMessage(messages, index);
              const artifact = artifacts[key] ?? fromSnapshot(message.metadata?.artifact);
              const isLatest = index === latestAssistantIndex;
              const kind = classifyResponseKind({
                intent: intent.intent,
                mode: (message.metadata?.mode ?? mode) as ChatMode,
                signals,
                artifactType: artifact.requested ? artifact.type : intent.artifact,
              });
              const format = artifact.format;
              const actions = actionRegistry(index, message, signals, intent, artifact);

              return (
                <div key={key} className="msg-in flex justify-start gap-3.5">
                  <span className="mt-0.5 hidden shrink-0 sm:block" aria-hidden="true">
                    <MatrixMark className="h-5 w-5 text-ink-3" />
                  </span>
                  <div className="min-w-0 max-w-[96%] flex-1 sm:max-w-none">
                    <AssistantMessage
                      message={message}
                      isLatest={isLatest}
                      streaming={streaming}
                      kind={kind}
                      signals={signals}
                      intent={intent}
                      artifact={artifact}
                      execution={isLatest ? execution : null}
                      timeLabel={message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                      actions={actions}
                      exportFormats={availableExportFormats(signals, intent.suppressExport ? [] : intent.formats)}
                      exportPickerOpen={exportPickerKey === key && !intent.suppressExport}
                      onCloseExportPicker={() => setExportPickerKey(null)}
                      onPickFormat={(next) => {
                        setExportPickerKey(null);
                        buildArtifactFor(key, next, message.content, firstHeading(message.content, "MATRIX response"));
                      }}
                      onGenerateArtifact={() => format && buildArtifactFor(key, format, message.content, firstHeading(message.content, "MATRIX response"))}
                      onDismissArtifact={() => {
                        builtRef.current.delete(key);
                        setArtifacts((current) => {
                          const next = { ...current };
                          delete next[key];
                          return next;
                        });
                      }}
                      onOpenArtifact={() => format && openBuilt(key, message.content, firstHeading(message.content, "MATRIX response"), format)}
                      onSaveArtifact={() => {
                        if (message.metadata?.image_data_url) saveDataUrl(message.metadata.image_data_url, `matrix-image-${key.slice(-6)}.png`);
                        else if (format) downloadBuilt(key, message.content, firstHeading(message.content, "MATRIX response"), format);
                      }}
                      onCopyArtifact={() => copyMessage(extractJson(message.content) ?? message.content)}
                      onOpenWorkspace={() => {
                        if (message.metadata?.artifacts?.length) {
                          setAgentFiles(message.metadata.artifacts);
                          setAgentProjectId(message.metadata.project_id ?? null);
                        }
                        setWorkspaceOpen(true);
                      }}
                      artifactActions={{
                        canOpen: Boolean(format && OPENABLE.includes(format)),
                        provider: kind === "image" ? "Together AI" : null,
                      }}
                    />
                  </div>
                </div>
              );
            })}

            {streaming ? (
              <div className="msg-in flex gap-3.5">
                <span className="mt-0.5 hidden shrink-0 sm:block" aria-hidden="true">
                  <MatrixMark className="h-5 w-5 text-ink-3" />
                </span>
                <div className="min-w-0 flex-1 border-l border-border pl-4">
                  {imageRun ? (
                    <ArtifactCard
                      state={beginArtifact(requestArtifact(emptyArtifactState(), { type: "IMAGE", title: "Matrix image" }))}
                      provider="Together AI"
                    />
                  ) : null}
                  <ResponseProgress mode={runMode} streamStatus={streamStatus} />
                  {streamedText ? (
                    <div className="ai-reply">
                      <Markdown text={streamedText} />
                      <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-ink align-middle" aria-hidden="true" />
                    </div>
                  ) : null}
                  {runIntent.intent === "AGENT_TASK" && execution.status !== "idle" ? (
                    <AgentActivityCard execution={execution} />
                  ) : null}
                </div>
              </div>
            ) : null}

            {failure ? (
              <ServerProblem failure={failure} onRetry={retry} onTryAnotherModel={tryAnotherModel} onDismiss={() => setFailure(null)} />
            ) : null}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {notice ? <p className="mt-2 shrink-0 text-[13px] text-ink-2">{notice}</p> : null}

      <div className="shrink-0 pt-3">
        <div className="mx-auto max-w-2xl">
          <ModeQuickActions
            mode={mode}
            signals={latestSignals}
            hasConversation={latestAssistantIndex >= 0 && !streaming}
            hasArtifacts={agentFiles.length > 0}
            onPrompt={(text) => void send(undefined, text)}
            onOpenWorkspace={() => setWorkspaceOpen(true)}
            studyLevel={studyLevel}
            setStudyLevel={setStudyLevel}
            explainStyle={explainStyle}
            setExplainStyle={setExplainStyle}
            compact={compact}
          />
          {graphNodes.length > 0 && (demoMode || mode === "orchestrator") ? <LiveTaskGraph nodes={graphNodes} /> : null}
          {modeHint ? (
            <p className="mb-2 text-[12px] text-ink-2">
              This may fit {modeHint} mode.{" "}
              <button type="button" className="font-semibold text-accent" onClick={() => { const next = modeHint; setModeHint(null); switchMode(next); }}>
                Continue in {modeHint}
              </button>
            </p>
          ) : null}
        </div>

        {attachments.length ? (
          <div className="mx-auto mb-2 flex max-w-2xl flex-wrap gap-1.5" aria-label="Attached files">
            {attachments.map((file) => (
              <span key={file.name} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2.5 pr-1 text-[11px] text-ink-2">
                <Code2 size={11} className="shrink-0" aria-hidden="true" />
                <span className="truncate font-mono">{file.name}</span>
                <span className="text-ink-3">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                <button
                  type="button"
                  onClick={() => setAttachments((current) => current.filter((item) => item.name !== file.name))}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-surface hover:text-danger"
                  aria-label={`Remove ${file.name}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <form onSubmit={(e) => void send(e)} className="composer-shell mx-auto max-w-2xl p-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,.txt,.md,.mdx,.json,.jsonc,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.html,.htm,.css,.scss,.sass,.less,.vue,.svelte,.sql,.graphql,.yaml,.yml,.toml,.xml,.env,.sh,.bash,.go,.rs,.java,.kt,.php,.rb,.swift,.dart,.c,.h,.cc,.cpp,.cs,Dockerfile,Makefile"
            className="sr-only"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <input
            ref={imageRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
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
            placeholder={modeMeta(mode).placeholder}
            rows={1}
            aria-label="Message MATRIX"
            disabled={streaming}
            className="max-h-36 min-h-11 w-full !border-0 !bg-transparent !px-1 !py-1.5 !shadow-none focus:!shadow-none focus:!outline-none focus:!ring-0"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            {/* Lightweight capability switches — clicking one activates the
                capability, it never invokes it on its own. */}
            <div className="flex min-w-0 items-center gap-0.5">
              <button type="button" onClick={() => fileRef.current?.click()} disabled={streaming} aria-label="Attach a file" title="Attach a file" className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
                <Paperclip size={16} strokeWidth={1.7} />
              </button>
              <button type="button" onClick={() => imageRef.current?.click()} disabled={streaming} aria-label="Attach an image" title="Attach an image" className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
                <ImageIcon size={16} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                onClick={() => setWebSearch((value) => !value)}
                aria-pressed={webSearch}
                aria-label="Use web knowledge"
                title="Use up-to-date web knowledge in the next answer"
                className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-[10px] transition-colors duration-150", webSearch ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink")}
              >
                <Globe size={16} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (mode === "code") setCodeHint((value) => !value);
                  else switchMode("code");
                }}
                aria-pressed={mode === "code" || codeHint}
                aria-label="Code mode"
                title={mode === "code" ? "Ask for complete, runnable code" : "Switch to Code mode"}
                className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-[10px] transition-colors duration-150", mode === "code" || codeHint ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink")}
              >
                <Code2 size={16} strokeWidth={1.7} />
              </button>
            </div>
            {streaming ? (
              <Button type="button" variant="ghost" onClick={stop} className="h-11 shrink-0 !px-3" aria-label="Stop generating">
                <Square size={14} strokeWidth={1.8} /> Stop
              </Button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && attachments.length === 0}
                aria-label={t("chat.send")}
                className={cn(
                  "grid h-11 w-11 shrink-0 place-items-center rounded-[10px] transition-colors duration-150 ease-out",
                  input.trim() || attachments.length > 0 ? "bg-accent text-white hover:bg-accent-hover" : "bg-surface-2 text-ink-3",
                )}
              >
                <Send size={16} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </form>

        <p className="mx-auto mt-2 max-w-2xl px-1 pb-1 text-[11px] text-ink-3">
          {mode === "agent" ? "Review files before preview or push" : "MATRIX may make mistakes · verify important information"}
        </p>
      </div>

      {mode === "agent" || agentFiles.length > 0 ? (
        <AgentWorkspace
          files={agentFiles}
          open={workspaceOpen}
          onClose={() => setWorkspaceOpen(false)}
          conversationId={convId}
          projectId={agentProjectId ?? undefined}
          model={activeModel ?? lastModel}
        />
      ) : null}
    </div>
  );
}
