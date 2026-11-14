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
  BrainCircuit, Code2, Download, ExternalLink, FileSearch, Globe, GraduationCap, Image as ImageIcon, Mic,
  Lock, MonitorPlay, Paperclip, Play, RefreshCcw, Send, ShieldAlert, Sparkles, Square, Trash2,
  WandSparkles, X, Zap,
} from "lucide-react";
import { AutoSpeakToggle } from "@/components/chat-speech-controls";
import {
  primeSpeech, readAutoSpeakPreference, speakMarkdown, speechTextFromMarkdown, stopSpeech, writeAutoSpeakPreference,
} from "@/lib/chat-speech";
import { firebaseBrowserConfigured, waitForAuthUser } from "@/lib/firebase/client";
import { rpc, uploadOwnedFile } from "@/lib/client/api";
import { notifyWorkDone } from "@/lib/client/work-notifications";
import { Button, Textarea } from "@/components/ui";
import { ModelPicker } from "@/components/model-picker";
import { Markdown } from "@/components/markdown";
import { MatrixMark, MatrixWordmark } from "@/components/logo";
import { useToast } from "@/components/toast";
import { ServerProblem } from "@/components/server-problem";
import { MATRIX_MODEL_LABEL } from "@/lib/ai/model";
import { classifyGatewayResponse, classifyRequestException, failureCopy, withRequestReference, type ApiFailure } from "@/lib/api-errors";
import { useI18n } from "@/lib/i18n/client";
import { useIsCompact } from "@/lib/client/use-media-query";
import { useChatScroll } from "@/lib/use-chat-scroll";
import { VoiceMessage } from "@/components/voice-message";
import { StreamingReply } from "@/components/streaming-reply";
import { createStreamStore } from "@/lib/stream-store";
import { VoiceProcessing, VoiceRecordingPanel, VoiceReviewBar, type VoiceReview } from "@/components/voice-composer";
import { VOICE_LANGUAGE_STORAGE_KEY, chooseVoiceEngine, mergeTranscript, voiceErrorMessage, voiceLanguage } from "@/lib/voice-input";
import { revealReceived, type RevealMode } from "@/lib/stream-reveal";
import { restoredPrependTop } from "@/lib/chat-scroll";
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
import { intentForMessage, latestArtifacts, latestProjectId, lastUserContent, messageKey, type ChatMessage, type MessageMetadata, type WorkingStep } from "@/lib/chat-messages";
import { ChatTopBar } from "@/components/chat-topbar";
import { AssistantMessage } from "@/components/assistant-message";
import { AgentWorkspace } from "@/components/agent-workspace";
import { ArtifactCard } from "@/components/artifact-panel";
import { ResponseProgress } from "@/components/response-status";
import { ModeQuickActions, LiveTaskGraph, type GraphNode } from "@/components/mode-workspace";
import { cancelsPendingTask, classifyAgentOutput, isClarificationAnswer, isTaskInterruption, requestsClarificationFirst, resumedTaskPrompt, pendingTaskFromMessages, type PendingAgentTask } from "@/lib/ai/agent-execution";
import { reportSuccessfulAiResponse } from "@/components/ai-status";
import { buildActionsFor, detectBuildIntent, detectImageAssetRequest, shouldRunBuildPipeline, type BuildIntent } from "@/lib/ai/build-intent";
import { mayExecuteAgent, shouldCreateCodeWorkspace } from "@/lib/ai/execution-policy";
import { BuildRunError, streamBuildRun } from "@/lib/client/build-runner";
import { BuildStatusCard } from "@/components/build/build-progress";
import { DeploySuccessPopup } from "@/components/build/deploy-card";
import { toRunSnapshot, type BuildRun } from "@/lib/deploy/stages";
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
  /** True when the conversation has messages older than `initialMessages`. */
  initialHasMore = false,
  initialProjectId = null,
  onConversationCreated,
}: {
  initialMessages: ChatMessage[];
  conversationId: string | null;
  isTemporary: boolean;
  initialMode?: ChatMode;
  initialHasMore?: boolean;
  initialProjectId?: string | null;
  onConversationCreated?: (id: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { t, locale } = useI18n();
  const compact = useIsCompact();

  // --- conversation -------------------------------------------------------
  const [mode, setMode] = useState<ChatMode>(isTemporary ? "general" : initialMode);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const agentTaskRef = useRef<PendingAgentTask | null>(pendingTaskFromMessages(initialMessages));
  const lastBuildTaskRef = useRef<PendingAgentTask | null>(null);
  const lastBuildVisibleRef = useRef<string | null>(null);
  // Incremental history: only the newest page is mounted; older messages are
  // prepended on demand so a long conversation never floods the DOM.
  const [hasMoreHistory, setHasMoreHistory] = useState(initialHasMore);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [input, setInput] = useState("");
  const [convId, setConvId] = useState<string | null>(initialConvId);
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(lastUserContent(initialMessages));
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [pendingImage, setPendingImage] = useState<{ name: string; storagePath: string; previewUrl: string; size: number } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  // --- capability selection (secondary; lives in the top bar / settings) ---
  const [lane, setLane] = useState<ModelLane>("auto");
  const [revealMode, setRevealMode] = useState<RevealMode>("adaptive");
  const revealModeRef = useRef<RevealMode>("adaptive");
  const preferenceMode = mode === "agent" || mode === "code" ? "agent" : "chat";
  useEffect(() => {
    let active = true;
    void fetch("/api/models", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return null;
      return response.json() as Promise<{ reveal_mode?: RevealMode }>;
    }).then((data) => {
      if (active && data?.reveal_mode && ["adaptive", "word", "natural", "reduced"].includes(data.reveal_mode)) { setRevealMode(data.reveal_mode); revealModeRef.current = data.reveal_mode; } }).catch(() => {});
    return () => { active = false; };
  }, []);
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
  // Streamed text lives outside React state: see lib/stream-store.ts.
  const streamStore = useMemo(() => createStreamStore(), []);
  const setStreamedText = useCallback((value: string | null) => streamStore.set(value ?? ""), [streamStore]);
  /** The message that replaced the live bubble — it must not replay the entry animation. */
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [streamCommitted, setStreamCommitted] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<"high" | "low" | null>(null);
  const [liveSteps, setLiveSteps] = useState<WorkingStep[]>([]);
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
  const [agentProjectId, setAgentProjectId] = useState<string | null>(initialProjectId ?? (initialConvId ? null : latestProjectId(initialMessages)));
  const explicitAgentProjectIdRef = useRef<string | null>(null);
  const [projectChoices, setProjectChoices] = useState<Array<{ id: string; title: string }>>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  // --- build pipeline (real execution state, mirrored from the server) -----
  const [buildRun, setBuildRun] = useState<BuildRun | null>(null);
  const [cancellingBuild, setCancellingBuild] = useState(false);
  /** True between "send" and the first server event, so the wait is explained. */
  const [buildPending, setBuildPending] = useState(false);
  const [publishPopup, setPublishPopup] = useState<{ run: BuildRun; url: string; files: number } | null>(null);
  const buildControllerRef = useRef<AbortController | null>(null);
  const lastBuildPromptRef = useRef<string | null>(null);

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
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveformSamplesRef = useRef<number[]>([]);
  const [draftAudio, setDraftAudio] = useState<{ blob: Blob; url: string; filename: string; durationMs: number; waveform: number[] } | null>(null);
  const discardRecordingRef = useRef(false);
  const recordingClockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingElapsedRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const visualFrameRef = useRef<number | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const voiceUploadRef = useRef(false);
  const [voiceAsset, setVoiceAsset] = useState<{ id: string; playbackUrl: string } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // --- voice input (dictation into the composer, every mode incl. Agent) ----
  const [voiceLang, setVoiceLangState] = useState("auto");
  const voiceLangRef = useRef("auto");
  const [voiceReview, setVoiceReview] = useState<VoiceReview | null>(null);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [voiceEngineNote, setVoiceEngineNote] = useState("");
  const [voiceHasWaveform, setVoiceHasWaveform] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Web Speech API has no lib.dom typings
  const recognitionRef = useRef<any>(null);
  const liveFinalRef = useRef("");
  const liveInterimRef = useRef("");
  const recognitionWantedRef = useRef(false);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY);
      if (saved) { const code = voiceLanguage(saved).code; voiceLangRef.current = code; setVoiceLangState(code); }
    } catch { /* private mode: the default (auto-detect) is used */ }
  }, []);
  const generatedAudioRef = useRef<HTMLAudioElement | null>(null);
  const generatedAudioUrlRef = useRef<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // State updates are batched; this synchronous guard prevents a fast Enter +
  // form-submit/click sequence from creating two provider requests.
  const requestInFlightRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const convIdRef = useRef<string | null>(initialConvId);
  /** Latest committed conversation, read while a request is in flight. */
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  const lastAttachmentsRef = useRef<PendingAttachment[]>([]);
  const lastImagePathRef = useRef<string | null>(null);
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

  useEffect(() => () => {
    discardRecordingRef.current = true;
    try { recorderRef.current?.stop(); } catch { /* recorder already stopped */ }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    if (recordingClockRef.current) clearInterval(recordingClockRef.current);
    if (visualFrameRef.current !== null) cancelAnimationFrame(visualFrameRef.current);
    void audioContextRef.current?.close();
    generatedAudioRef.current?.pause();
    if (generatedAudioUrlRef.current) URL.revokeObjectURL(generatedAudioUrlRef.current);
  }, []);
  useEffect(() => { localeRef.current = locale; }, [locale]);

  const chatScroll = useChatScroll(scrollAreaRef, scrollContentRef, `${messages.length}:${buildRun?.updatedAt ?? 0}:${liveSteps.length}:${streamCommitted}`);

  /** Fetch the previous page of messages and prepend it, keeping the reading
      position stable. */
  const loadOlderMessages = useCallback(async () => {
    const id = convIdRef.current;
    if (!id || loadingHistory || !hasMoreHistory) return;
    const oldest = messagesRef.current[0]?.created_at;
    if (!oldest) return;

    setLoadingHistory(true);
    const viewport = scrollAreaRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    chatScroll.beginPrepend();
    try {
      const page = await rpc<{ hasMore: boolean; messages: ChatMessage[] }>("conversation_messages_page", {
        id,
        before: oldest,
        limit: 30,
      });
      setMessages((current) => [...page.messages, ...current]);
      setHasMoreHistory(page.hasMore);
      // Restore the scroll offset after the taller list paints.
      requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop = restoredPrependTop(previousTop, previousHeight, viewport.scrollHeight);
        chatScroll.endPrepend();
      });
    } catch {
      chatScroll.endPrepend();
      setNotice("Older messages could not be loaded. Please try again.");
    } finally {
      setLoadingHistory(false);
    }
  }, [hasMoreHistory, loadingHistory, chatScroll.beginPrepend, chatScroll.endPrepend]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    stopSpeech();
    stopGeneratedSpeech();
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
    stopGeneratedSpeech();
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

  /**
   * Requested → Generating → Ready (or Failed) for one message.
   *
   * Async because PDFs are rendered by the shared server-side engine
   * (`/api/export/pdf`), which embeds real Unicode fonts and shapes the text.
   */
  async function buildArtifactFor(key: string, format: ExportFormat, content: string, title: string) {
    updateArtifact(key, (current) => beginArtifact(requestArtifact(current, { format, title })));
    try {
      const built = await buildArtifact(format, content, title);
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
  }

  async function artifactSource(key: string, content: string, title: string, format: ExportFormat) {
    const cached = builtRef.current.get(key);
    if (cached && cached.filename.endsWith(`.${format === "markdown" ? "md" : format}`)) return cached;
    const built = await buildArtifact(format, content, title);
    if (built) builtRef.current.set(key, built);
    return built;
  }

  async function downloadBuilt(key: string, content: string, title: string, format: ExportFormat) {
    let built: BuiltArtifact | null = null;
    try {
      built = await artifactSource(key, content, title, format);
    } catch {
      built = null;
    }
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

  async function openBuilt(key: string, content: string, title: string, format: ExportFormat) {
    let built: BuiltArtifact | null = null;
    try {
      built = await artifactSource(key, content, title, format);
    } catch {
      built = null;
    }
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
    void buildArtifactFor(key, format, content, firstHeading(content, "MATRIX response"));
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
    buildControllerRef.current?.abort(new DOMException("Stopped by user.", "AbortError"));
    setStreaming(false);
    setNotice("Stopped. The build keeps running on the server if it was already publishing — refresh the project to see its real state.");
  }

  function toggleAutoSpeak() {
    const next = !autoSpeak;
    setAutoSpeak(next);
    autoSpeakRef.current = next;
    writeAutoSpeakPreference(next);
    if (!next) {
      stopSpeech();
      stopGeneratedSpeech();
      setSpeakingId(null);
    }
  }

  function stopGeneratedSpeech() {
    generatedAudioRef.current?.pause();
    generatedAudioRef.current = null;
    if (generatedAudioUrlRef.current) URL.revokeObjectURL(generatedAudioUrlRef.current);
    generatedAudioUrlRef.current = null;
  }

  async function listenTo(id: string, text: string, isLatest = false) {
    if (mode === "agent") return;
    if (speakingId === id || (speakingId === "auto" && isLatest)) {
      stopSpeech();
      stopGeneratedSpeech();
      setSpeakingId(null);
      return;
    }
    stopSpeech();
    stopGeneratedSpeech();
    setSpeakingId(id);
    const plain = speechTextFromMarkdown(text);
    try {
      const response = await fetch("/api/voice/speech", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: plain }),
      });
      if (!response.ok) throw new Error("Server speech synthesis is not configured or unavailable");
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      generatedAudioUrlRef.current = url;
      generatedAudioRef.current = audio;
      audio.onended = () => {
        stopGeneratedSpeech();
        setSpeakingId((current) => (current === id ? null : current));
      };
      audio.onerror = () => {
        stopGeneratedSpeech();
        setSpeakingId((current) => (current === id ? null : current));
        setNotice("AI-generated speech could not be played by this browser.");
      };
      await audio.play();
    } catch {
      // Keep the existing browser voice as a truthful accessibility fallback;
      // the generated-audio endpoint never fabricates a successful response.
      setNotice("AI speech synthesis is unavailable right now; using your device's built-in voice instead.");
      primeSpeech();
      const ok = speakMarkdown(text, {
        locale: localeRef.current,
        onend: () => setSpeakingId((current) => (current === id ? null : current)),
        onerror: () => setSpeakingId((current) => (current === id ? null : current)),
      });
      if (!ok) setSpeakingId(null);
    }
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

  async function deleteVoiceAsset(id: string) {
    try {
      const response = await fetch(`/api/voice/audio/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("The private recording could not be deleted from storage.");
      setVoiceAsset((current) => current?.id === id ? null : current);
      setMessages((current) => current.map((message) => {
        if (message.metadata?.audio_asset_id !== id) return message;
        return { ...message, metadata: { ...message.metadata, audio_asset_id: undefined } };
      }));
      setNotice("Private voice recording deleted. The transcript remains in the chat.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Voice deletion failed. Try again.");
    }
  }

  function setVoiceLang(code: string) {
    const next = voiceLanguage(code).code;
    voiceLangRef.current = next;
    setVoiceLangState(next);
    try { window.localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, next); } catch { /* not persisted */ }
    // Changing language mid-recording restarts live recognition in the new
    // language; the audio recording itself continues untouched.
    if (recognitionRef.current && recognitionWantedRef.current) {
      stopRecognition();
      if (next !== "auto") startRecognition(next);
      else setVoiceEngineNote("Auto-detect: the recording is transcribed when you stop.");
    }
  }

  /** Start the browser's speech recogniser. Returns false when unavailable. */
  function startRecognition(lang: string): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vendor-prefixed constructor
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Ctor) return false;
    try {
      const recognition = new Ctor();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SpeechRecognitionEvent
      recognition.onresult = (event: any) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = String(result[0]?.transcript ?? "");
          if (result.isFinal) liveFinalRef.current = mergeTranscript(liveFinalRef.current, text);
          else interim += text;
        }
        liveInterimRef.current = interim.trim();
        setLiveTranscript(mergeTranscript(liveFinalRef.current, interim));
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SpeechRecognitionErrorEvent
      recognition.onerror = (event: any) => {
        const code = String(event?.error ?? "");
        // "no-speech"/"aborted" are routine; the recogniser restarts in onend.
        if (code === "not-allowed" || code === "service-not-allowed" || code === "language-not-supported" || code === "network") {
          recognitionWantedRef.current = false;
          // The recording (when there is one) is still transcribed by the server.
          setVoiceEngineNote(recorderRef.current ? "Live transcription is unavailable here; the recording is transcribed when you stop." : voiceErrorMessage(code));
          if (!recorderRef.current) { setRecording(false); setNotice(voiceErrorMessage(code)); if (recordingClockRef.current) clearInterval(recordingClockRef.current); }
        }
      };
      recognition.onend = () => {
        // Browsers end recognition after a pause; keep listening until Stop.
        if (recognitionWantedRef.current && recognitionRef.current === recognition) {
          try { recognition.start(); } catch { /* already restarting */ }
        }
      };
      recognitionRef.current = recognition;
      recognitionWantedRef.current = true;
      recognition.start();
      return true;
    } catch {
      recognitionRef.current = null;
      recognitionWantedRef.current = false;
      return false;
    }
  }

  function stopRecognition() {
    recognitionWantedRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) { try { recognition.stop(); } catch { /* not running */ } }
  }

  /** Put recognised words into the composer as ordinary, editable text. */
  function placeTranscript(text: string, review: VoiceReview) {
    setInput((current) => mergeTranscript(current, text));
    setVoiceReview(review);
    setNotice(null);
    requestAnimationFrame(() => {
      autosize();
      const field = textareaRef.current;
      if (field) { field.focus(); const end = field.value.length; try { field.setSelectionRange(end, end); } catch { /* unsupported input type */ } }
    });
  }

  /**
   * Server transcription of a recording. The transcript is placed in the
   * composer for review — it is never sent automatically.
   */
  async function uploadAndTranscribeVoice(draft: NonNullable<typeof draftAudio>, retryId?: string) {
    if (!draft.blob.size || voiceUploadRef.current) return;
    if (draft.blob.size > 24 * 1024 * 1024) {
      setDraftAudio(draft);
      setNotice("This recording exceeds the speech provider's 24 MB limit. Make a shorter recording; the local copy is still playable below.");
      return;
    }
    voiceUploadRef.current = true;
    setTranscribing(true);
    setNotice(null);
    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    // Agent/Code turns and temporary chats send text only, so their audio is
    // transcribed and discarded. Ordinary chats keep a private, playable copy
    // when the deployment has storage configured.
    const keepRecording = mode !== "agent" && mode !== "code" && !isTemporary;
    try {
      const form = new FormData();
      if (retryId) form.append("audio_asset_id", retryId);
      else {
        form.append("audio", draft.blob, draft.filename);
        form.append("duration_ms", String(draft.durationMs));
        form.append("waveform", draft.waveform.join(","));
      }
      form.append("language", voiceLangRef.current);
      form.append("store", keepRecording ? "1" : "0");
      const response = await fetch("/api/voice/transcribe", { method: "POST", credentials: "same-origin", body: form, signal: controller.signal });
      const data = await response.json().catch(() => ({})) as { transcript?: string; audio_asset_id?: string | null; playback_url?: string | null; detected_language?: string | null; error?: string };
      if (data.audio_asset_id && data.playback_url) setVoiceAsset({ id: data.audio_asset_id, playbackUrl: data.playback_url });
      const transcript = data.transcript?.trim() ?? "";
      if (!response.ok || !transcript) {
        // Server could not transcribe: fall back to whatever the browser heard.
        const heard = mergeTranscript(liveFinalRef.current, liveInterimRef.current).trim();
        if (heard) {
          placeTranscript(heard, { source: "browser", language: voiceLangRef.current === "auto" ? null : voiceLangRef.current, durationMs: draft.durationMs });
          setDraftAudio(draft);
          return;
        }
        setDraftAudio(draft); // recorded bytes survive upload and STT failures
        setNotice(voiceErrorMessage(response.ok ? "EMPTY_TRANSCRIPT" : String(data.error ?? response.status)));
        return;
      }
      placeTranscript(transcript, {
        source: "server", language: data.detected_language ?? null, durationMs: draft.durationMs,
        asset: data.audio_asset_id ? { id: data.audio_asset_id, durationMs: draft.durationMs, waveform: draft.waveform, language: data.detected_language ?? null } : null,
      });
      // Keep the local recording so it can be transcribed again in another language.
      setDraftAudio(draft);
    } catch (error) {
      setDraftAudio(draft);
      if (!(error instanceof Error && error.name === "AbortError")) {
        setNotice(error instanceof Error ? `Voice transcription failed: ${error.message}. Your recording is kept — retry below.` : voiceErrorMessage("unknown"));
      }
    } finally {
      if (transcribeAbortRef.current === controller) transcribeAbortRef.current = null;
      voiceUploadRef.current = false;
      setTranscribing(false);
    }
  }

  /** Recording finished: use the browser's transcript when it has one, else the server. */
  function finishVoiceCapture(draft: NonNullable<typeof draftAudio> | null, durationMs: number) {
    stopRecognition();
    const heard = mergeTranscript(liveFinalRef.current, liveInterimRef.current).trim();
    setLiveTranscript("");
    if (heard) {
      placeTranscript(heard, { source: "browser", language: voiceLangRef.current === "auto" ? null : voiceLangRef.current, durationMs });
      if (draft) setDraftAudio(draft);
      return;
    }
    if (draft) { void uploadAndTranscribeVoice(draft); return; }
    setNotice(voiceErrorMessage("no-speech"));
  }

  function discardDraftAudio() {
    setDraftAudio((current) => { if (current) URL.revokeObjectURL(current.url); return null; });
  }

  /** Drop the transcript review state (the text itself is handled by the caller). */
  function clearVoiceReview(options: { deleteAsset?: boolean } = {}) {
    const assetId = voiceReview?.asset?.id ?? voiceAsset?.id ?? null;
    setVoiceReview(null);
    discardDraftAudio();
    liveFinalRef.current = "";
    liveInterimRef.current = "";
    if (options.deleteAsset && assetId) void deleteVoiceAsset(assetId);
  }

  function retranscribeVoice() {
    if (!draftAudio || transcribing) return;
    // Replace the previous transcript rather than appending a second copy.
    setInput("");
    const previous = voiceReview?.asset?.id ?? null;
    setVoiceReview(null);
    liveFinalRef.current = "";
    liveInterimRef.current = "";
    if (previous) void deleteVoiceAsset(previous);
    void uploadAndTranscribeVoice(draftAudio);
  }

  function cancelVoiceRecording() {
    discardRecordingRef.current = true;
    stopRecognition();
    liveFinalRef.current = "";
    liveInterimRef.current = "";
    setLiveTranscript("");
    const active = recorderRef.current;
    if (active && active.state !== "inactive") active.stop();
    else {
      if (recordingClockRef.current) clearInterval(recordingClockRef.current);
      setRecording(false);
      setRecordingPaused(false);
    }
    setNotice("Recording discarded. Nothing was uploaded.");
  }

  function pauseVoiceRecording() {
    const active = recorderRef.current;
    if (!active) return;
    if (active.state === "recording") {
      active.pause(); setRecordingPaused(true);
      if (recognitionRef.current) { recognitionWantedRef.current = false; try { recognitionRef.current.stop(); } catch { /* idle */ } }
    } else if (active.state === "paused") {
      active.resume(); setRecordingPaused(false);
      if (recognitionRef.current) { recognitionWantedRef.current = true; try { recognitionRef.current.start(); } catch { /* already listening */ } }
    }
  }

  async function toggleVoiceRecording() {
    const active = recorderRef.current;
    if (active && active.state !== "inactive") { active.stop(); return; }
    // Recognition-only capture (no recorder on this browser) is stopped here.
    if (recording && !active) {
      if (recordingClockRef.current) clearInterval(recordingClockRef.current);
      setRecording(false);
      setRecordingPaused(false);
      finishVoiceCapture(null, recordingElapsedRef.current * 1000);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vendor-prefixed constructor
    const hasRecognition = Boolean((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);
    const hasRecorder = Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
    const plan = chooseVoiceEngine(voiceLangRef.current, {
      speechRecognition: hasRecognition, mediaRecorder: hasRecorder,
      mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), online: navigator.onLine !== false,
    });
    if (!plan.engine) { setNotice("Voice input is unsupported by this browser or device."); return; }
    liveFinalRef.current = "";
    liveInterimRef.current = "";
    setLiveTranscript("");
    setVoiceEngineNote(plan.reason);
    if (!hasRecorder) {
      // Old WebViews: speech recognition only (no waveform, no server fallback).
      const lang = voiceLangRef.current === "auto" ? (navigator.language || "en-US") : voiceLangRef.current;
      if (!startRecognition(lang)) { setNotice("Voice input is unsupported by this browser or device."); return; }
      setVoiceHasWaveform(false);
      setRecordingSeconds(0);
      recordingElapsedRef.current = 0;
      recordingClockRef.current = setInterval(() => { recordingElapsedRef.current += 1; setRecordingSeconds(recordingElapsedRef.current); }, 1000);
      setRecording(true);
      setNotice(null);
      return;
    }
    try {
      setVoiceHasWaveform(true);
      // A new recording appends to the transcript already in the composer;
      // only the previous local audio is dropped.
      discardDraftAudio();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (plan.live) startRecognition(voiceLangRef.current);
      mediaStreamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      discardRecordingRef.current = false;
      recorderRef.current = recorder;
      setRecordingSeconds(0);
      recordingElapsedRef.current = 0;
      waveformSamplesRef.current = [];
      setRecordingPaused(false);
      recordingClockRef.current = setInterval(() => {
        if (recorder.state === "recording") { recordingElapsedRef.current += 1; setRecordingSeconds(recordingElapsedRef.current); }
      }, 1000);
      // Web Audio visualization is optional: capture stays usable on browsers
      // that deny AudioContext or do not support an analyser.
      try {
        const context = new AudioContext();
        audioContextRef.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        void context.resume().catch(() => {});
        const samples = new Uint8Array(analyser.fftSize);
        let lastDraw = 0;
        const draw = (time: number) => {
          if (time - lastDraw >= 90 && recorder.state === "recording") {
            analyser.getByteTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / samples.length);
            const level = Math.max(2, Math.min(100, Math.round(rms * 270)));
            const values = waveformSamplesRef.current;
            values.push(level);
            if (values.length > 60) values.shift();
            const canvas = waveformCanvasRef.current;
            const ctx = canvas?.getContext("2d");
            if (canvas && ctx) {
              const scale = window.devicePixelRatio || 1;
              const w = canvas.clientWidth * scale;
              const h = canvas.clientHeight * scale;
              if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
              ctx.clearRect(0, 0, w, h);
              ctx.fillStyle = "#ef7474";
              const count = 48;
              for (let i = 0; i < count; i++) {
                const sample = values[values.length - count + i] ?? 2;
                const height = Math.max(3 * scale, h * sample / 110);
                ctx.fillRect(i * w / count + scale, (h - height) / 2, Math.max(scale, w / count - 2 * scale), height);
              }
            }
            lastDraw = time;
          }
          visualFrameRef.current = requestAnimationFrame(draw);
        };
        draw(performance.now());
      } catch { /* duration and recording remain available */ }
      recorder.ondataavailable = (event) => { if (event.data.size) audioChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        discardRecordingRef.current = true;
        setNotice("The browser could not record audio. Check microphone permission and try again.");
        if (recorder.state !== "inactive") recorder.stop();
      };
      recorder.onstop = () => {
        setRecording(false);
        setRecordingPaused(false);
        if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
        if (recordingClockRef.current) clearInterval(recordingClockRef.current);
        if (visualFrameRef.current !== null) cancelAnimationFrame(visualFrameRef.current);
        void audioContextRef.current?.close();
        audioContextRef.current = null;
        recordingTimeoutRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        const type = recorder.mimeType || "audio/webm";
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
        recorderRef.current = null;
        if (!discardRecordingRef.current) {
          const blob = new Blob(audioChunksRef.current, { type });
          const durationMs = recordingElapsedRef.current * 1000;
          const draft = blob.size ? { blob, url: URL.createObjectURL(blob), filename: `voice-${Date.now()}.${extension}`,
            durationMs, waveform: [...waveformSamplesRef.current] } : null;
          // The transcript goes to the composer for review; nothing is sent yet.
          if (draft || liveFinalRef.current || liveInterimRef.current) finishVoiceCapture(draft, durationMs);
          else { stopRecognition(); setNotice("No audio was captured. Try again."); }
        } else {
          stopRecognition();
        }
        audioChunksRef.current = [];
      };
      recorder.start(1000);
      setRecording(true);
      setNotice(null);
      recordingTimeoutRef.current = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 600_000);
    } catch (error) {
      setRecording(false);
      stopRecognition();
      setNotice(voiceErrorMessage(error instanceof Error ? error.name : "unknown"));
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }

  async function streamMessage(
    message: string,
    opts: {
      replaceLastAssistant?: boolean;
      reuseUser?: boolean;
      regenerate?: boolean;
      attachments?: PendingAttachment[];
      imageStoragePath?: string | null;
      intent?: IntentResult;
      turnId?: string;
      audioAssetId?: string | null;
      taskContext?: PendingAgentTask | null;
    } = {},
  ) {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const replaceLastAssistant = opts.replaceLastAssistant === true;
    const sentAttachments = opts.attachments ?? [];
    const imageStoragePath = opts.imageStoragePath ?? null;
    const turnId = opts.turnId ?? crypto.randomUUID();

    // --- intent detection → capability selection -------------------------
    const intent = opts.intent ?? detectIntent(message, { mode, codeCapability: codeHint, agentMode: mode === "agent" });
    // When an image is attached, we are analysing an uploaded image — never generating one.
    const capability = imageStoragePath ? "chat" : selectCapability(intent, mode);
    const messageMode = effectiveMode(intent, mode);
    const isImage = !imageStoragePath && capability === "image";
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
    setLiveSteps([]);
    setActiveProvider(null);
    setActiveTier(null);
    setLastUserMessage(message);
    if (isImage) imagePromptRef.current = message;
    const startedAt = Date.now();
    setActiveStartedAt(startedAt);
    setActiveModel(lastModel);
    setStreamedText("");
    setStreamCommitted(false);
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
    stopGeneratedSpeech();
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
    let paintFrame: number | null = null;
    let visible = "";
    const queuePaint = () => {
      if (paintFrame !== null) return;
      paintFrame = requestAnimationFrame(() => {
        paintFrame = null;
        visible = revealReceived(collected, visible, revealModeRef.current);
        setStreamedText(visible);
        if (visible.length < collected.length) queuePaint();
      });
    };
    const cancelPaint = () => {
      if (paintFrame !== null) cancelAnimationFrame(paintFrame);
      paintFrame = null;
    };
    let committed = false;
    let committedKey: string | null = null;
    const streamMetadata: MessageMetadata = {};

    const commit = (text: string) => {
      cancelPaint();
      visible = text;
      setStreamCommitted(true);
      if (text.trim()) reportSuccessfulAiResponse();
      if (opts.taskContext) {
        const state = opts.taskContext.state === "CONVERSATION" ? "CONVERSATION" : classifyAgentOutput(text).state;
        const task = { ...opts.taskContext, state };
        streamMetadata.agent_task = task;
        agentTaskRef.current = state === "CLARIFICATION_REQUIRED" ? task : null;
      }
      const key = commitPartial(text, { replaceLastAssistant, turnId, intent }, streamMetadata);
      if (key) { committedKey = key; setSettledKey(key); }
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
          stream: !isImage && !isOrchestrator && messageMode !== "agent",
          conversation_id: convIdRef.current,
          project_id: agentProjectId,
          is_temporary: isTemporary,
          mode: messageMode,
          lane,
          strategy,
          study_level: studyLevel,
          explain_style: explainStyle,
          message,
          task_context: opts.taskContext ?? undefined,
          audio_asset_id: opts.audioAssetId ?? undefined,
          image_storage_path: imageStoragePath ?? undefined,
          attachments: sentAttachments.map(({ name, content, type }) => ({ name, content, type })),
          language: locale,
          regenerate: opts.regenerate === true,
          reuse_user: opts.reuseUser === true || opts.regenerate === true,
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
          tier?: "high" | "low";
          steps?: WorkingStep[];
          duration_ms?: number;
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
          streamMetadata.provider = data.provider ?? "together";
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
          streamMetadata.tier = data.tier;
          if (data.steps?.length) streamMetadata.steps = data.steps;
          if (typeof data.duration_ms === "number") streamMetadata.duration_ms = data.duration_ms;
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
        tier?: "high" | "low";
        step?: WorkingStep;
        steps?: WorkingStep[];
        duration_ms?: number;
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
        if (data.stream_status) setStreamStatus((old) => old === data.stream_status ? old : data.stream_status!);
        if (data.tier) {
          streamMetadata.tier = data.tier;
          setActiveTier((old) => old === data.tier ? old : data.tier!);
        }
        if (data.step) {
          const incoming = data.step;
          setLiveSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === incoming.id);
            const next = idx >= 0 ? prev.map((s, i) => (i === idx ? incoming : s)) : [...prev, incoming];
            streamMetadata.steps = next;
            return next;
          });
        }
        if (data.steps?.length) {
          streamMetadata.steps = data.steps;
          setLiveSteps(data.steps);
        }
        if (typeof data.duration_ms === "number") {
          streamMetadata.duration_ms = data.duration_ms;
        }
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
        if (data.model) { streamMetadata.model = data.model; setActiveModel((old) => old === data.model ? old : data.model!); }
        if (data.mode) streamMetadata.mode = data.mode;
        if (typeof data.coding_detected === "boolean") streamMetadata.coding_detected = data.coding_detected;
        if (data.provider) { streamMetadata.provider = data.provider; setActiveProvider((old) => old === data.provider ? old : data.provider!); }
        if (typeof data.delta === "string") {
          collected += data.delta;
          if (messageMode !== "agent") queuePaint();
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
        void notifyWorkDone({
          title: "MATRIX finished responding",
          body: firstHeading(collected, "Your answer is ready."),
          link: gotConversationId ? `/chat/${gotConversationId}` : "/chat",
          onlyWhenBackgrounded: true,
        });
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
      cancelPaint();
      clearIdleTimer();
      setStreaming(false);
      setStreamedText(null);
      setActiveStartedAt(null);
      abortRef.current = null;
      requestInFlightRef.current = false;
      setStreamStatus(null);
    }
  }

  async function send(e?: { preventDefault(): void }, messageOverride?: string, voice?: { id: string; durationMs: number; waveform: number[]; language: string | null }) {
    e?.preventDefault();
    const pending = messageOverride ? [] : attachments;
    const attachedImage = messageOverride ? null : pendingImage;
    // A reviewed voice transcript in an ordinary chat is sent as a voice
    // message (edited text + the private recording). Agent/Code turns, and
    // turns with attachments, send the transcript as normal text.
    if (!voice && !messageOverride && voiceReview?.asset && !pending.length && !attachedImage && mode !== "agent" && mode !== "code" && input.trim()) {
      voice = voiceReview.asset;
    }
    const hadVoiceReview = Boolean(voiceReview);
    const unusedVoiceAssetId = !voice ? voiceReview?.asset?.id ?? null : null;
    const audioAssetId = voice?.id ?? null;
    let message =
      (messageOverride ?? input).trim() ||
      (attachedImage ? "Analyse this attached image clearly and thoroughly." : pending.length ? "Review these attached files and help me with them." : "");
    if (!message || streaming || uploadingImage || requestInFlightRef.current) return;
    // Composer capabilities are opt-in hints, never automatic invocations.
    const rawMessage = message;
    if (!messageOverride) {
      if (webSearch) message = `Use up-to-date public knowledge where it helps.\n\n${message}`;
      if (codeHint) message = `Answer with complete, runnable code when it helps.\n\n${message}`;
    }
    if (!voice || hadVoiceReview) setInput("");
    if (hadVoiceReview) {
      setVoiceReview(null);
      discardDraftAudio();
      liveFinalRef.current = "";
      liveInterimRef.current = "";
      if (unusedVoiceAssetId) void deleteVoiceAsset(unusedVoiceAssetId);
    }
    lastAttachmentsRef.current = pending;
    lastImagePathRef.current = attachedImage?.storagePath ?? null;
    setAttachments([]);
    if (attachedImage) {
      URL.revokeObjectURL(attachedImage.previewUrl);
      setPendingImage(null);
    }
    setVoiceAsset(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // --- intent detection happens on the user's own words -----------------
    const intent = detectIntent(rawMessage, {
      mode,
      codeCapability: codeHint || mode === "code",
      agentMode: mode === "agent",
    });
    const turnId = crypto.randomUUID();
    const allAttachmentNames = [
      ...(attachedImage ? [attachedImage.name] : []),
      ...pending.map((file) => file.name),
    ];
    setMessages((current) => [...current, {
      role: "user",
      content: message,
      created_at: new Date().toISOString(),
      metadata: {
        mode,
        ...(voice ? { audio_asset_id: voice.id, audio_duration_ms: voice.durationMs, audio_waveform: voice.waveform, audio_language: voice.language } : {}),
        attachment_names: allAttachmentNames,
        ...(audioAssetId ? { audio_asset_id: audioAssetId } : {}),
        intent: intent.intent,
        artifact_type: intent.artifact,
        turn_id: turnId,
      },
    }]);
    const hinted = suggestMode(rawMessage, mode);
    if (hinted && hinted !== effectiveMode(intent, mode)) setModeHint(hinted);
    if (mode === "orchestrator") setGraphNodes(planOrchestrator(rawMessage).map((task) => ({ id: task.id, title: task.title, status: "running" as const })));

    // --- build / publish intent (§2, §25, §26) ----------------------------
    // "Make it", "build this website and publish it" run the real pipeline:
    // plan → files → build → validate → publish. A plain question never gets
    // here, and an under-specified "make it" asks one question instead of
    // deploying a guess.
    const pendingTask = agentTaskRef.current;
    if (pendingTask && mode === "agent") {
      if (cancelsPendingTask(rawMessage)) {
        if (isTemporary) {
          agentTaskRef.current = null;
          commitPartial("Okay, I won't start the build. Your existing project is unchanged.", { turnId }, { mode: "agent", agent_task: { ...pendingTask, state: "CONVERSATION" }, execution_state: "CONVERSATION" });
        } else {
          try {
            const res = await fetch("/api/ai", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "cancel_pending_task", conversation_id: convIdRef.current, original_request: pendingTask.originalRequest }) });
            if (!res.ok) throw new Error("CANCEL_PENDING_TASK_FAILED");
            agentTaskRef.current = null;
            commitPartial("Okay, I won't start the build. Your existing project is unchanged.", { turnId }, { mode: "agent", agent_task: { ...pendingTask, state: "CONVERSATION" }, execution_state: "CONVERSATION" });
          } catch {
            setFailure({ ...failureCopy("server"), title: "Cancellation could not be saved", detail: "Retry cancellation so the task does not resume after a reload." });
          }
        }
        return;
      }
      if (isClarificationAnswer(rawMessage)) {
        const updated: PendingAgentTask = {
          ...pendingTask,
          clarifications: [...pendingTask.clarifications, {
            question: [...messages].reverse().find((item) => item.role === "assistant")?.content ?? "Clarification",
            answer: rawMessage,
          }].slice(-10),
        };
        // Carry the original requirements into generation; never replace the
        // user's visible answer with the synthetic build prompt in chat history.
        await runBuildTurn(resumedTaskPrompt(updated, rawMessage), detectBuildIntent(updated.originalRequest, { mode: "agent", agentMode: true, projectFileCount: agentFiles.length || (agentProjectId ? 1 : 0) }), turnId, pending, false, updated, rawMessage);
        return;
      }
      // An uncertain answer remains pending. A different conversational
      // question interrupts the task rather than silently starting a build.
      const context: PendingAgentTask = isTaskInterruption(rawMessage)
        ? { ...pendingTask, state: "CONVERSATION" }
        : { ...pendingTask, clarifications: [...pendingTask.clarifications, {
          question: [...messages].reverse().find((item) => item.role === "assistant")?.content ?? "Clarification",
          answer: rawMessage,
        }].slice(-10) };
      if (context.state === "CONVERSATION") agentTaskRef.current = null;
      await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId, taskContext: context });
      return;
    }
    if (mode === "agent" && requestsClarificationFirst(rawMessage)) {
      const task: PendingAgentTask = { originalRequest: rawMessage, clarifications: [], state: "CLARIFICATION_REQUIRED", projectId: agentProjectId };
      await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId, taskContext: task });
      return;
    }
    const buildIntent = detectBuildIntent(rawMessage, {
      mode,
      agentMode: mode === "agent",
      projectFileCount: agentFiles.length || (agentProjectId ? 1 : 0),
      priorPlan: lastAssistantContent(messages),
      hasAttachments: pending.length > 0,
    });
    if (buildIntent.needsClarification) {
      setNotice(buildIntent.clarification ?? "Describe what to build and I will create, validate and (if you ask) publish it.");
      await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId,
        taskContext: mode === "agent" ? { originalRequest: rawMessage, clarifications: [], state: "CLARIFICATION_REQUIRED", projectId: agentProjectId } : null });
      return;
    }
    const codeWorkspaceRequest = mode === "code" && shouldCreateCodeWorkspace(rawMessage, pending);
    if (codeWorkspaceRequest && !buildIntent.publish && !buildIntent.preview) {
      await runBuildTurn(message, { ...buildIntent, build: true, publish: false, preview: false, fix: false }, turnId, pending, true);
      return;
    }
    if (mayExecuteAgent(mode, buildIntent) && shouldRunBuildPipeline(buildIntent)) {
      await runBuildTurn(message, buildIntent, turnId, pending, false);
      return;
    }
    await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId });
  }

  /**
   * Run the real build pipeline for one user turn (§24). The chat shows the
   * server's stage state, never a simulated one, and the publish popup only
   * appears when the hosting provider reported a live deployment.
   */
  async function cancelBuildRun() {
    if (!buildRun || cancellingBuild) return;
    setCancellingBuild(true);
    try {
      const res = await fetch(`/api/build?run_id=${encodeURIComponent(buildRun.id)}`, { method: "DELETE", credentials: "same-origin" });
      if (res.ok) setBuildRun((current) => current ? { ...current, cancelRequested: true } : current);
    } catch { /* the next poll still reports the server truth */ }
    finally { setCancellingBuild(false); }
  }

  async function runBuildTurn(
    message: string,
    buildIntent: BuildIntent,
    turnId: string,
    sentAttachments: PendingAttachment[] = [],
    workspaceOnly = false,
    taskContext: PendingAgentTask | null = null,
    visibleMessage?: string,
  ) {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const selectedForThisRequest = taskContext?.projectId ?? (message === lastBuildPromptRef.current ? explicitAgentProjectIdRef.current : null);
    if (!selectedForThisRequest) explicitAgentProjectIdRef.current = null;
    lastBuildPromptRef.current = message;
    lastBuildTaskRef.current = taskContext;
    lastBuildVisibleRef.current = visibleMessage ?? null;
    const startedAt = Date.now();
    setFailure(null);
    setProjectChoices([]);
    setNotice(null);
    setStreaming(true);
    setStreamStatus("processing");
    setBuildRun(null);
    setBuildPending(true);
    setActiveStartedAt(startedAt);
    setStreamedText("");
    setStreamCommitted(false);
    stopSpeech();
    stopGeneratedSpeech();

    const controller = new AbortController();
    buildControllerRef.current = controller;
    abortRef.current = controller;
    const actions = workspaceOnly
      ? { ...buildActionsFor(buildIntent), build: true, publish: false, preview: false, fix: false }
      : buildActionsFor(buildIntent);
    const imageRequests = detectImageAssetRequest(message) ? imageRequestsFor(message) : [];
    // Attachments travel as files, not as pasted text: the pipeline stores them
    // in the project so the validator, preview and host all see the real source.
    const attachmentFiles = sentAttachments.map((file) => ({ name: file.name.replace(/^\/+/, ""), content: file.content }));

    let settled: { run: BuildRun | null; reply: string; projectId: string | null; conversationId: string | null } = {
      run: null,
      reply: "",
      projectId: null,
      conversationId: null,
    };
    let buildError: { code: string; message: string } | null = null;
    try {
      if (!firebaseBrowserConfigured) {
        setFailure({ ...failureCopy("not-configured"), detail: "The MATRIX backend is not configured on this deployment yet, so nothing can be built." });
        return;
      }
      settled = await streamBuildRun(
        {
          prompt: message,
          taskContext,
          visibleMessage,
          projectId: selectedForThisRequest,
          workspaceProjectId: agentProjectId,
          conversationId: convIdRef.current,
          isTemporary,
          mode: mode === "code" ? "code" : "agent",
          workspaceOnly,
          actions,
          imageRequests,
          // Attachments go to the pipeline as files, not as pasted text: they
          // become project records the validator and preview can actually read.
          attachments: attachmentFiles.length ? attachmentFiles : undefined,
        },
        {
          signal: controller.signal,
          onRun: (run) => {
            setBuildPending(false);
            setBuildRun(run);
            // Show the model that is producing the files.
            if (run.model) {
              const { model: runModel, provider: runProvider } = run.model;
              setActiveModel((old) => old === runModel ? old : runModel);
              setActiveProvider((old) => old === runProvider ? old : runProvider);
            }
            if (run.projectId && run.projectId !== agentProjectId) setAgentProjectId(run.projectId);
          },
          onError: (code, detail) => {
            buildError = { code, message: detail };
          },
        },
      );
    } catch (err) {
      buildError = err instanceof BuildRunError
        ? { code: err.code, message: err.code === "PROJECT_CONTEXT_MISSING" ? "This Chat is unavailable. Open a Chat you own and retry." : err.code === "PROJECT_STORAGE_UNAVAILABLE" ? "Project storage is unavailable. No build started; retry after Firestore is restored." : `Build service rejected the request (${err.code}).` }
        : { code: "BUILD_UNREACHABLE", message: "MATRIX could not reach the build service. Your message is safe — try again." };
      if (!(err instanceof Error && (err.name === "AbortError" || err instanceof BuildRunError))) console.error("[MATRIX] build stream failed", err);
    } finally {
      clearIdleTimer();
      setStreaming(false);
      setStreamStatus(null);
      setBuildPending(false);
      setActiveStartedAt(null);
      abortRef.current = null;
      buildControllerRef.current = null;
      requestInFlightRef.current = false;
    }

    const run = settled.run;
    if (run?.status === "awaiting_input") {
      const task: PendingAgentTask = { originalRequest: taskContext?.originalRequest ?? visibleMessage ?? message,
        clarifications: taskContext?.clarifications ?? [], state: "CLARIFICATION_REQUIRED", projectId: run.projectId ?? taskContext?.projectId, taskId: run.taskId };
      agentTaskRef.current = task;
      setBuildRun(null);
      setFailure(null);
      reportSuccessfulAiResponse();
    } else if (run?.status === "succeeded") {
      agentTaskRef.current = null;
      if (actions.build && run.changes.length > 0) reportSuccessfulAiResponse();
    }
    const liveUrl = run?.deployment?.status === "live" ? run.deployment.url ?? null : null;
    // The run owns its conversation: adopt it (and the URL) so a refresh lands
    // on the thread that contains this build.
    if (settled.conversationId) {
      rememberConv(settled.conversationId);
      if (!isTemporary) {
        const targetUrl = `/chat/${settled.conversationId}`;
        if (!window.location.pathname.startsWith(targetUrl)) window.history.replaceState(null, "", targetUrl);
      }
    }

    // Refresh the workspace file list from the project — the files the Agent
    // actually wrote, not a reconstruction from the reply text.
    let artifacts: AgentFile[] = [];
    const projectId = run?.projectId ?? settled.projectId ?? agentProjectId;
    if (projectId) {
      try {
        const project = await rpc<{ files: Array<{ path: string; content: string; language: string }> }>("project_get", { id: projectId });
        artifacts = project.files
          .filter((file) => file.content.length <= 200_000)
          .map((file) => ({ path: file.path, content: file.content, language: file.language }));
        if (artifacts.length) setAgentFiles(artifacts);
      } catch {
        /* the workspace will load them itself */
      }
    }

    const replyText =
      settled.reply.trim() ||
      (run?.status === "succeeded"
        ? workspaceOnly
          ? `Wrote ${run.fileCount || artifacts.length} project file${(run.fileCount || artifacts.length) === 1 ? "" : "s"} to the workspace. Review the files there; build checks and deployment were not run.`
          : liveUrl
          ? `Built and published ${run.fileCount || artifacts.length || attachmentFiles.length} project file${run.fileCount === 1 ? "" : "s"}. The live address is below.`
          : `Build and validation passed. ${run.fileCount || artifacts.length} file${run.fileCount === 1 ? "" : "s"} are ready to preview.`
        : buildError
          ? `${buildError.message}${buildError.code ? ` (${buildError.code})` : ""}`
          : "MATRIX stopped before the build finished. Open Deployment details to see where it ended.");

    commitPartial(
      replyText,
      { turnId },
      {
        mode: mode === "code" ? "code" : "agent",
        project_id: projectId ?? undefined,
        ...(run?.model ? { model: run.model.model, provider: run.model.provider } : {}),
        build: run && run.status !== "awaiting_input" ? toRunSnapshot(run) : undefined,
        agent_task: run?.status === "awaiting_input" ? agentTaskRef.current ?? undefined : undefined,
        deployment: run?.deployment
          ? {
              id: run.deployment.id,
              status: run.deployment.status,
              url: run.deployment.status === "live" ? run.deployment.url : null,
              slug: run.deployment.slug,
              environment: run.deployment.environment,
              files: run.fileCount,
            }
          : undefined,
        duration_ms: Date.now() - startedAt,
      },
    );

    if (run?.status === "failed" || buildError) {
      const detail = run?.error?.message ?? buildError?.message ?? "The build stopped before publishing.";
      if (run?.error?.code === "PROJECT_AMBIGUOUS" || run?.error?.code === "PROJECT_CONTEXT_MISSING") {
        // The owner-scoped list includes every selectable project, including
        // candidates beyond the short diagnostic stored in a build run.
        void rpc<Array<{ id: string; title: string }>>("project_list")
          .then(setProjectChoices).catch(() => setProjectChoices([]));
      }
      setFailure({ ...failureCopy("server"), title: run?.deployment?.status === "failed" ? "Publishing failed" : "Build failed", detail, retryable: true });
    }
    if (run?.status === "succeeded") explicitAgentProjectIdRef.current = null;
    if (liveUrl && run) {
      setPublishPopup({ run, url: liveUrl, files: run.fileCount || artifacts.length });
      // Keep the live card visible for this turn only as long as the popup is
      // open; after it is dismissed the committed message row carries the link.
      setBuildRun(null);
      void notifyWorkDone({
        title: "MATRIX published your build",
        body: `Live at ${liveUrl}`,
        link: liveUrl,
      });
    } else if (run?.status === "succeeded") {
      void notifyWorkDone({
        title: "MATRIX build finished",
        body: `${run.fileCount || artifacts.length} project file(s) ready.`,
        link: projectId ? `/projects/${projectId}` : "/projects",
      });
    }
  }

  function retryBuild() {
    const prompt = lastBuildPromptRef.current;
    if (!prompt || streaming) return;
    // A failed CREATE may already have persisted its project. Retrying must
    // continue that ID, not create another copy in the same chat.
    if (buildRun?.projectId) explicitAgentProjectIdRef.current = buildRun.projectId;
    setFailure(null);
    const task = lastBuildTaskRef.current;
    if (task) {
      void runBuildTurn(prompt, detectBuildIntent(task.originalRequest, { mode: "agent", agentMode: true, projectFileCount: agentFiles.length || (agentProjectId ? 1 : 0) }), crypto.randomUUID(), lastAttachmentsRef.current, false, task, lastBuildVisibleRef.current ?? undefined);
    } else {
      void send(undefined, prompt);
    }
  }

  /**
   * Which generated images the request asked for (§27). Kept deliberately
   * small and deterministic: the pipeline stores each one as a real project
   * file and reuses an existing asset with the same prompt.
   */
  function imageRequestsFor(text: string): Array<{ name: string; prompt: string }> {
    const subject = text.replace(/^(?:please\s+)?(?:build|make|create|design)\s+(?:me\s+)?(?:a|an|the)?\s*/i, "").slice(0, 180);
    const wanted = /hero|banner|background/i.test(text) ? 1 : 0;
    const features = /feature|benefit|card/i.test(text) ? 2 : 0;
    const count = Math.min(3, Math.max(1, wanted + features));
    return Array.from({ length: count }, (_, index) => ({
      name: index === 0 ? "hero" : `feature-${index}`,
      prompt:
        index === 0
          ? `Editorial website hero illustration for: ${subject}. Deep obsidian background, mint-green and violet accent light, geometric, no text, no words, no logos.`
          : `Abstract product feature illustration for: ${subject}. Dark obsidian palette with subtle mint accents, minimal vector style, no text.`,
    }));
  }

  function regenerate() {
    if (!lastUserMessage || streaming) return;
    void streamMessage(lastUserMessage, {
      replaceLastAssistant: true,
      regenerate: true,
      reuseUser: true,
      attachments: lastAttachmentsRef.current,
      imageStoragePath: lastImagePathRef.current,
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
    void streamMessage(lastUserMessage, {
      reuseUser: Boolean(convIdRef.current),
      attachments: lastAttachmentsRef.current,
      imageStoragePath: lastImagePathRef.current,
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
    // MATRIX runs only GPT OSS 120B, a text model. Images cannot be read, so
    // nothing is uploaded and the limitation is stated plainly.
    setFailure(failureCopy("vision-unsupported"));
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
        else if (artifact.format) void downloadBuilt(key, message.content, title, artifact.format);
      },
      editPrompt: () => {
        const prompt = imagePromptRef.current ?? lastUserMessage ?? "";
        setInput(prompt);
        textareaRef.current?.focus();
        requestAnimationFrame(autosize);
      },
      sources: () => askFollowUp("List the sources and evidence behind that answer, and mark anything you could not verify."),
      export: () => setExportPickerKey((current) => (current === key ? null : key)),
      open: () => artifact.format && void openBuilt(key, message.content, title, artifact.format),
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

  const modeReply = [...messages].reverse().find((item) => item.role === "assistant" && (preferenceMode === "agent" ? item.metadata?.mode === "agent" || item.metadata?.mode === "code" : item.metadata?.mode !== "agent" && item.metadata?.mode !== "code"));
  const currentProvider = streaming ? activeProvider : modeReply?.metadata?.provider;
  const currentModel = streaming ? activeModel : modeReply?.metadata?.model;
  const routingLabel = currentProvider || currentModel ? [currentProvider, currentModel].filter(Boolean).join(" · ") : null;
  const latestAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  }, [messages]);
  const latestSignals = latestAssistantIndex >= 0 ? signalsByIndex[latestAssistantIndex] : null;
  const imageRun = streaming && runIntent.intent === "IMAGE_GENERATION";

  // Token frames update only the active reply. Completed conversation rows are
  // reused until their own content, actions or metadata actually change.
  const renderedHistory = useMemo(
    () => messages.map((message, index) => {
              const key = messageKey(message, index);
              if (message.role === "user") {
                return (
                  <div key={key} className="msg-in flex justify-end gap-3.5">
                    <div className="min-w-0 max-w-[88%] sm:max-w-[75%]">
                      <div className="rounded-[16px] border border-border bg-surface-2 px-4 py-2.5 text-[14.5px] leading-relaxed text-ink">
                        {message.metadata?.audio_asset_id
                          ? <VoiceMessage id={message.metadata.audio_asset_id} transcript={message.content} durationMs={message.metadata.audio_duration_ms} waveform={message.metadata.audio_waveform} language={message.metadata.audio_language} onDelete={() => void deleteVoiceAsset(message.metadata!.audio_asset_id!)} />
                          : <p className="whitespace-pre-wrap break-words">{message.content}</p>}
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
                <div key={key} className={cn(key !== settledKey && "msg-in", "flex justify-start gap-3.5")}>
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
                      liveBuildRun={isLatest ? buildRun : null}
                      onRetryBuild={retryBuild}
                      timeLabel={message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                      actions={actions}
                      exportFormats={availableExportFormats(signals, intent.suppressExport ? [] : intent.formats)}
                      exportPickerOpen={exportPickerKey === key && !intent.suppressExport}
                      onCloseExportPicker={() => setExportPickerKey(null)}
                      onPickFormat={(next) => {
                        setExportPickerKey(null);
                        void buildArtifactFor(key, next, message.content, firstHeading(message.content, "MATRIX response"));
                      }}
                      onGenerateArtifact={() => format && void buildArtifactFor(key, format, message.content, firstHeading(message.content, "MATRIX response"))}
                      onDismissArtifact={() => {
                        builtRef.current.delete(key);
                        setArtifacts((current) => {
                          const next = { ...current };
                          delete next[key];
                          return next;
                        });
                      }}
                      onOpenArtifact={() => format && void openBuilt(key, message.content, firstHeading(message.content, "MATRIX response"), format)}
                      onSaveArtifact={() => {
                        if (message.metadata?.image_data_url) saveDataUrl(message.metadata.image_data_url, `matrix-image-${key.slice(-6)}.png`);
                        else if (format) void downloadBuilt(key, message.content, firstHeading(message.content, "MATRIX response"), format);
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
                        provider: kind === "image" ? (message.metadata?.provider ?? "together") : null,
                      }}
                    />
                  </div>
                </div>
              );
            }),
    [messages, signalsByIndex, artifacts, latestAssistantIndex, streaming, buildRun, execution, settledKey,
      exportPickerKey, mode, compact, speakingId, agentFiles, agentProjectId, lastUserMessage, t, router],
  );

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
          routingLabel={MATRIX_MODEL_LABEL}
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

      <div className="relative min-h-0 flex-1">
      <div ref={scrollAreaRef} onScroll={chatScroll.onScroll} onWheel={chatScroll.onWheel}
        onTouchStart={chatScroll.onTouchStart} onTouchMove={chatScroll.onTouchMove}
        onKeyDown={chatScroll.onKeyDown} onPointerDown={chatScroll.onPointerDown} onPointerUp={chatScroll.onPointerUp}
        className="chat-viewport h-full overflow-y-auto overscroll-contain px-0.5 py-2 sm:px-2" tabIndex={0}>
        <div ref={scrollContentRef} className="space-y-7">
        {hasMoreHistory && messages.length > 0 ? (
          <div className="flex justify-center pb-1">
            <button
              type="button"
              onClick={() => void loadOlderMessages()}
              disabled={loadingHistory}
              className="chip"
              aria-busy={loadingHistory}
            >
              {loadingHistory ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          </div>
        ) : null}
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
            {renderedHistory}

            {streaming && !streamCommitted ? (
              <div className="msg-in flex justify-start gap-3.5">
                <span className="mt-0.5 hidden shrink-0 sm:block" aria-hidden="true">
                  <MatrixMark className="h-5 w-5 text-ink-3" />
                </span>
                {/* Same box as a committed assistant message, so nothing shifts when the stream completes. */}
                <div className="min-w-0 max-w-[96%] flex-1 sm:max-w-none">
                  {imageRun ? (
                    <ArtifactCard
                      state={beginArtifact(requestArtifact(emptyArtifactState(), { type: "IMAGE", title: "Matrix image" }))}
                      provider="together"
                    />
                  ) : null}
                  {buildRun ? null : (
                    <ResponseProgress
                      mode={runMode}
                      streamStatus={streamStatus}
                      steps={liveSteps}
                      provider={activeProvider}
                      model={activeModel}
                      tier={activeTier}
                    />
                  )}
                  <StreamingReply store={streamStore} />
                  {buildRun ? (
                    <BuildStatusCard run={buildRun} cancelling={cancellingBuild} onCancel={() => { void cancelBuildRun(); }} />
                  ) : buildPending ? (
                    <div className="sandbox-card fade-in rounded-xl border border-border bg-surface p-3.5">
                      <p className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                        <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
                        Starting build
                      </p>
                      <p className="mt-1 text-[11.5px] text-ink-3">Accepting the run and reading the project…</p>
                    </div>
                  ) : null}

                </div>
              </div>
            ) : null}

            {failure ? (
              <ServerProblem failure={failure} onRetry={buildRun?.status === "failed" ? retryBuild : retry} onDismiss={() => setFailure(null)} />
            ) : null}
            {projectChoices.length ? (
              <div className="rounded-xl border border-border bg-surface p-4" role="group" aria-label="Choose project to edit">
                <p className="mb-2 text-sm font-medium text-ink">Which project should MATRIX edit?</p>
                <div className="flex flex-wrap gap-2">
                  {projectChoices.map((choice) => (
                    <button key={choice.id} type="button" className="rounded-lg border border-border px-3 py-2 text-sm text-ink hover:bg-surface-2"
                      onClick={() => { explicitAgentProjectIdRef.current = choice.id; setAgentProjectId(choice.id); setProjectChoices([]); setNotice(`Selected ${choice.title}. Press Retry to run your previous request on this project, or write a new instruction.`); }}>
                      {choice.title} · {choice.id.slice(0, 8)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
        </div>
      </div>
      {chatScroll.newBelow ? (
        <button type="button" onClick={chatScroll.follow}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-md"
          aria-label="Scroll to new content">New content below ↓</button>
      ) : null}
      </div>

      <div className="mx-auto mb-2 flex max-w-2xl flex-wrap items-center justify-end gap-2 text-[11px] text-ink-3"><label htmlFor="stream-reveal">Response display</label><select id="stream-reveal" aria-label="Response display mode" className="rounded-md border border-border bg-surface px-2 py-1 text-ink" value={revealMode} onChange={(event) => { const next = event.target.value as RevealMode; setRevealMode(next); revealModeRef.current = next; void rpc("settings_update", { stream_reveal_mode: next }).catch(() => setNotice("Display preference could not be saved.")); }}><option value="adaptive">Adaptive typing</option><option value="word">Word by word</option><option value="natural">Natural stream</option><option value="reduced">Reduced motion</option></select></div>
      {transcribing ? <VoiceProcessing onCancel={() => transcribeAbortRef.current?.abort()} /> : null}
      {voiceReview && !recording && !transcribing ? (
        <VoiceReviewBar
          review={voiceReview}
          language={voiceLang}
          onLanguage={setVoiceLang}
          canRetranscribe={Boolean(draftAudio) && draftAudio!.blob.size <= 24 * 1024 * 1024}
          busy={streaming}
          onRetranscribe={retranscribeVoice}
          onRecordMore={() => void toggleVoiceRecording()}
          onDiscard={() => { setInput(""); clearVoiceReview({ deleteAsset: true }); if (textareaRef.current) textareaRef.current.style.height = "auto"; }}
        />
      ) : null}
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

        {draftAudio && !transcribing && !voiceReview && !recording ? <div className="mx-auto mb-2 flex max-w-2xl flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"><audio controls src={draftAudio.url} aria-label="Voice recording ready to retry" className="h-9 min-w-0 flex-1" />{draftAudio.blob.size <= 24 * 1024 * 1024 ? <button type="button" className="rounded-lg bg-accent px-3 py-2 text-sm text-white" onClick={() => void uploadAndTranscribeVoice(draftAudio, voiceAsset?.id)}>Retry transcription</button> : null}<button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => { discardDraftAudio(); if (voiceAsset) void deleteVoiceAsset(voiceAsset.id); }}>Discard</button></div> : null}
        {pendingImage || uploadingImage ? (
          <div className="mx-auto mb-2 flex max-w-2xl items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
            {uploadingImage ? (
              <span className="text-xs text-ink-2">Uploading image privately to Cloudinary…</span>
            ) : pendingImage ? (
              <>
                <span className="flex min-w-0 items-center gap-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pendingImage.previewUrl} alt={pendingImage.name} className="h-10 w-10 shrink-0 rounded-md border border-border object-cover" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-ink">{pendingImage.name}</span>
                    <span className="block text-[11px] text-ink-3">{Math.max(1, Math.round(pendingImage.size / 1024))} KB · Cloudinary private · ask anything or press Send</span>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    URL.revokeObjectURL(pendingImage.previewUrl);
                    setPendingImage(null);
                  }}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface hover:text-danger"
                  aria-label="Remove attached image"
                >
                  <X size={13} />
                </button>
              </>
            ) : null}
          </div>
        ) : null}
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

        <form onSubmit={(e) => { if (recording) e.preventDefault(); else void send(e); }} className="composer-shell mx-auto max-w-2xl p-3">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.mdx,.json,.jsonc,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.html,.htm,.css,.scss,.sass,.less,.vue,.svelte,.sql,.graphql,.yaml,.yml,.toml,.xml,.env,.sh,.bash,.go,.rs,.java,.kt,.php,.rb,.swift,.dart,.c,.h,.cc,.cpp,.cs,Dockerfile,Makefile"
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
          {recording ? <VoiceRecordingPanel
            paused={recordingPaused}
            seconds={recordingSeconds}
            canvasRef={waveformCanvasRef}
            liveTranscript={liveTranscript}
            engineNote={voiceEngineNote}
            hasWaveform={voiceHasWaveform}
            canPause={voiceHasWaveform}
            language={voiceLang}
            onLanguage={setVoiceLang}
            onCancel={cancelVoiceRecording}
            onPause={pauseVoiceRecording}
            onStop={() => void toggleVoiceRecording()}
          /> : <Textarea
            ref={textareaRef}
            value={input}
            dir="auto"
            onChange={(e) => {
              setInput(e.target.value);
              // Once the text is cleared there is no transcript left to review.
              if (!e.target.value.trim() && voiceReview) clearVoiceReview({ deleteAsset: true });
              requestAnimationFrame(autosize);
            }}
            onPaste={(e) => {
              const item = Array.from(e.clipboardData?.items ?? []).find((entry) => entry.type.startsWith("image/"));
              if (item) {
                const file = item.getAsFile();
                if (file) {
                  e.preventDefault();
                  void handleFile(file);
                }
              }
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
          }
          {!recording ? <div className="mt-2 flex items-center justify-between gap-2">
            {/* Lightweight capability switches — clicking one activates the
                capability, it never invokes it on its own. */}
            <div className="flex min-w-0 items-center gap-0.5">
              {/* Voice input is part of the composer in every mode, including Agent. */}
              <button type="button" onClick={() => void toggleVoiceRecording()} disabled={streaming || transcribing} aria-label={voiceReview ? "Record more voice input" : "Voice input"} title={`Voice input · ${voiceLanguage(voiceLang).label}`} className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-[10px] transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-50", voiceReview ? "bg-accent-soft text-accent" : "text-ink-3")}><Mic size={16} strokeWidth={1.7} /></button>
              <button type="button" onClick={() => fileRef.current?.click()} disabled={streaming} aria-label="Attach a file" title="Attach a file" className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
                <Paperclip size={16} strokeWidth={1.7} />
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
              <ModelPicker />
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
          </div> : null}
        </form>

        <p className="mx-auto mt-2 max-w-2xl px-1 pb-1 text-[11px] text-ink-3">
          {mode === "agent" ? "Review files before preview or push" : "MATRIX may make mistakes · verify important information"}
        </p>
      </div>

      {publishPopup ? (
        <DeploySuccessPopup
          run={publishPopup.run}
          url={publishPopup.url}
          files={publishPopup.files}
          onClose={() => {
            setPublishPopup(null);
            setBuildRun(null);
          }}
          onViewProject={() => {
            const projectId = publishPopup.run.projectId;
            setPublishPopup(null);
            if (projectId) router.push(`/projects/${projectId}`);
            else setWorkspaceOpen(true);
          }}
          onDeploymentDetails={() => {
            setPublishPopup(null);
            setWorkspaceOpen(true);
          }}
          onAssets={() => {
            setPublishPopup(null);
            setWorkspaceOpen(true);
          }}
          onRollback={() => {
            setPublishPopup(null);
            setWorkspaceOpen(true);
          }}
        />
      ) : null}

      {mode === "agent" || agentFiles.length > 0 ? (
        <AgentWorkspace
          files={agentFiles}
          open={workspaceOpen}
          onClose={() => setWorkspaceOpen(false)}
          conversationId={convId}
          projectId={agentProjectId ?? undefined}
          onProjectId={setAgentProjectId}
          model={activeModel ?? lastModel}
        />
      ) : null}
    </div>
  );
}
