"use client";

// =============================================================================
// QORVYNA chat — context-aware, intent-driven.
//
//   USER INTENT → CAPABILITY SELECTION → EXECUTION → CONTEXTUAL UI
//
// A normal conversation renders exactly four things: the user message, the
// QORVYNA reply, its contextual actions (Copy · Regenerate · More ▾) and the
// composer. Export, Agent execution, image generation, analytics and activity
// are real capabilities, but each one is mounted only when the user's intent
// (or the content of the reply) makes it relevant.
//
// Chat and Agent are ONE surface: the same toolbar, message rows, composer,
// voice messages, attachments, streaming and message actions. Switching
// between them — or between models — never leaves the conversation.
//
// Fakes-free contract: every assistant message comes from the real gateway.
// Any failure renders "Server problem" with a [Retry] — never a canned reply,
// never an endless loader, and never a simulated reasoning trace.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown, BookOpen, Braces, BrainCircuit, Code2, Copy, Download, ExternalLink, FileDown, FileSearch, Flag, GraduationCap,
  Image as ImageIcon, Layers, Lightbulb, Lock, MonitorPlay, Pencil, Play, RefreshCcw, RotateCcw, Share2, ShieldAlert, Sparkles,
  Trash2, Volume2, VolumeX, WandSparkles, X, Zap,
} from "lucide-react";
import {
  primeSpeech, readAutoSpeakPreference, speakMarkdown, speechTextFromMarkdown, stopSpeech, writeAutoSpeakPreference,
} from "@/lib/chat-speech";
import { fbAuth, firebaseBrowserConfigured, waitForAuthUser } from "@/lib/firebase/client";
import { mintSessionCookie, optionalAuthHeaders, rpc } from "@/lib/client/api";
import { useAuthLifecycle } from "@/components/auth/auth-provider";
import { startAuthLifecycle } from "@/lib/auth/lifecycle";
import { logAuthEvent } from "@/lib/auth/diagnostics";
import { notifyWorkDone } from "@/lib/client/work-notifications";
import { loadModelPool } from "@/components/model-picker";
import { QorvynaMark } from "@/components/logo";
import { useToast } from "@/components/toast";
import { ServerProblem } from "@/components/server-problem";
import { ConfirmModal } from "@/components/modal";
import { classifyGatewayResponse, classifyRequestException, failureCopy, withRequestReference, type ApiFailure } from "@/lib/api-errors";
import { useI18n } from "@/lib/i18n/client";
import { useHydrated } from "@/lib/client/use-hydrated";
import { useIsCompact } from "@/lib/client/use-media-query";
import { useChatScroll } from "@/lib/use-chat-scroll";
import { StreamingReply } from "@/components/streaming-reply";
import { createStreamStore } from "@/lib/stream-store";
import { ChatComposer } from "@/components/chat-composer";
import { UserMessage } from "@/components/user-message";
import type { ChatAction } from "@/components/response-actions";
import { MAX_AUDIO_BYTES, MIN_RECORDING_MS, useVoiceRecorder, type VoiceCapture, type VoiceClip } from "@/lib/client/use-voice-recorder";
import { useKeyboardInset } from "@/lib/client/use-keyboard-inset";
import { copyText, shareText } from "@/lib/client/share";
import { clearDraft, enqueueOutboxMessage, listOutboxMessages, loadDraft, removeOutboxMessage, saveCachedConversation, saveDraft } from "@/lib/client/offline-store";
import {
  VOICE_LANGUAGE_STORAGE_KEY,
  VOICE_MODE_STORAGE_KEY,
  formatClock,
  mergeTranscript,
  normalizeVoiceInputMode,
  voiceErrorMessage,
  voiceLanguage,
  type VoiceInputMode,
} from "@/lib/voice-input";
import { revealReceived, type RevealMode } from "@/lib/stream-reveal";
import { restoredPrependTop } from "@/lib/chat-scroll";
import { cn } from "@/lib/utils";
import { languageForPath, type AgentFile, type TextAttachment } from "@/lib/ai/agent";
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
import {
  intentForMessage, lastIndexOfRole, latestArtifacts, latestProjectId, messageKey, patchTurnMessage, promptFor, versionsAfterReplace,
  type ChatMessage, type MessageMetadata, type ReplyVersion, type WorkingStep,
} from "@/lib/chat-messages";
import { ChatTopBar, type ToolbarStatus } from "@/components/chat-topbar";
import { AssistantMessage } from "@/components/assistant-message";
import { AgentWorkspace } from "@/components/agent-workspace";
import { ArtifactCard } from "@/components/artifact-panel";
import { ResponseProgress } from "@/components/response-status";
import { ModeQuickActions, LiveTaskGraph, type GraphNode } from "@/components/mode-workspace";
import { cancelsPendingTask, classifyAgentOutput, isClarificationAnswer, isTaskInterruption, requestsClarificationFirst, resumedTaskPrompt, pendingTaskFromMessages, type PendingAgentTask } from "@/lib/ai/agent-execution";
import { reportSuccessfulAiResponse } from "@/components/ai-status";
import { NO_BUILD_INTENT, buildActionsFor, detectBuildIntent, detectImageAssetRequest, shouldRunBuildPipeline, type BuildIntent } from "@/lib/ai/build-intent";
import { agentHandoffReason, approvedIntent, isConversationMode, mayExecuteAgent, shouldCreateCodeWorkspace, type HandoffReason } from "@/lib/ai/execution-policy";
import { outcomeOfRequestError, outcomeOfRun } from "@/lib/ai/task-outcome";
import { ExecutionHandoff } from "@/components/build/execution-handoff";
import { BuildRunError, streamBuildRun } from "@/lib/client/build-runner";
import { BuildStatusCard } from "@/components/build/build-progress";
import { DeploySuccessPopup } from "@/components/build/deploy-card";
import { toRunSnapshot, type BuildRun } from "@/lib/deploy/stages";
import { planOrchestrator } from "@/lib/ai/router";
import type { AgentStageId, PipelineAnalytics } from "@/lib/ai/pipeline";
import { JarvisAssistantBar } from "@/components/voice/jarvis-assistant-bar";
import { DEFAULT_JARVIS_SETTINGS, type JarvisSettings } from "@/lib/voice/jarvis-engine";

export type { ChatMessage, MessageMetadata };

type PendingAttachment = TextAttachment & { size: number };

/** A turn whose user bubble is already in the conversation. */
type TurnOptions = {
  /** A voice message: the recording is already shown and has been transcribed. */
  voice?: { turnId: string; assetId: string | null; attachments: PendingAttachment[] };
  /** Edit & resend, or sending again a message that never reached the server. */
  resend?: { turnId: string; stored: boolean; replaceReply: boolean; attachments: PendingAttachment[] };
  /** The user chose a chat answer for a request the Agent could run. */
  chatOnly?: boolean;
};

/** Real project work asked for in a conversation mode: waiting for one tap. */
type PendingHandoff = {
  turnId: string;
  message: string;
  rawMessage: string;
  intent: BuildIntent;
  reason: HandoffReason;
  attachments: PendingAttachment[];
  audioAssetId: string | null;
  reuseUser: boolean;
};

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const TEXT_FILE = /(?:^|\.)(?:txt|md|mdx|json|jsonc|js|jsx|mjs|cjs|ts|tsx|py|html?|css|scss|sass|less|vue|svelte|sql|graphql|ya?ml|toml|xml|env|sh|bash|go|rs|java|kt|php|rb|swift|dart|c|h|cc|cpp|cs|csv|log)$/i;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** Unsent composer text, kept per conversation for this tab. */
const DRAFT_PREFIX = "matrix.chat.draft:";

function timeLabelOf(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const CONNECT_TIMEOUT_MS = 25_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Formats a browser can open inline; the rest are download-only. */
const OPENABLE: ExportFormat[] = ["pdf", "markdown", "txt", "json", "csv"];

/** One icon per action, so the row reads the same on every message. */
const ACTION_ICON: Partial<Record<ResponseActionId, ReactNode>> = {
  copy: <Copy size={14} strokeWidth={1.8} />,
  regenerate: <RefreshCcw size={14} strokeWidth={1.8} />,
  listen: <Volume2 size={14} strokeWidth={1.8} />,
  copyCode: <Code2 size={14} strokeWidth={1.8} />,
  run: <Play size={14} strokeWidth={1.8} />,
  explain: <Lightbulb size={14} strokeWidth={1.8} />,
  save: <Download size={14} strokeWidth={1.8} />,
  editPrompt: <Pencil size={14} strokeWidth={1.8} />,
  sources: <BookOpen size={14} strokeWidth={1.8} />,
  export: <FileDown size={14} strokeWidth={1.8} />,
  open: <ExternalLink size={14} strokeWidth={1.8} />,
  copyJson: <Braces size={14} strokeWidth={1.8} />,
  flashcards: <Layers size={14} strokeWidth={1.8} />,
  workspace: <MonitorPlay size={14} strokeWidth={1.8} />,
  report: <Flag size={14} strokeWidth={1.8} />,
};

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

async function parseGatewayError(res: Response): Promise<{ code: string | null; conversationId: string | null; requestId: string | null; userMessageId: string | null }> {
  try {
    const data = (await res.json()) as { error?: unknown; conversation_id?: unknown; user_message_id?: unknown };
    return {
      code: typeof data.error === "string" ? data.error : null,
      conversationId: typeof data.conversation_id === "string" ? data.conversation_id : null,
      requestId: res.headers.get("X-QORVYNA-Request-ID"),
      userMessageId: typeof data.user_message_id === "string" ? data.user_message_id : null,
    };
  } catch {
    // Non-JSON error body (proxy/host interstitial) — still surface the id.
    return { code: null, conversationId: null, requestId: res.headers.get("X-QORVYNA-Request-ID"), userMessageId: null };
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
  initialExecutionState = null,
  initialAgentSessionId = null,
  initialTitle = "",
  onConversationCreated,
}: {
  initialMessages: ChatMessage[];
  conversationId: string | null;
  isTemporary: boolean;
  initialMode?: ChatMode;
  initialHasMore?: boolean;
  initialProjectId?: string | null;
  initialExecutionState?: string | null;
  initialAgentSessionId?: string | null;
  /** Title of a saved conversation, shown in the toolbar and its settings. */
  initialTitle?: string;
  onConversationCreated?: (id: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { t, locale } = useI18n();
  const hydrated = useHydrated();
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
  const jarvisSettingsRef = useRef<JarvisSettings>(DEFAULT_JARVIS_SETTINGS);
  const jarvisDispatchRef = useRef<((text: string) => Promise<void>) | null>(null);
  const [convId, setConvId] = useState<string | null>(initialConvId);
  const [title, setTitle] = useState(initialTitle);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [pendingImage, setPendingImage] = useState<{ name: string; storagePath: string; previewUrl: string; size: number } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  /** A problem with what is being prepared in the composer (a rejected file, …). */
  const [composerError, setComposerError] = useState<string | null>(null);

  // --- message actions ------------------------------------------------------
  /** Key of the user message whose inline editor is open. */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  /** The message waiting for the delete confirmation. */
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; role: "user" | "assistant" } | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The reply being regenerated: hidden while its replacement streams in. */
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  /** The last turn sent from this screen — what Retry needs to avoid duplicates. */
  const lastTurnRef = useRef<{ turnId: string; stored: boolean; audioAssetId: string | null } | null>(null);
  /** The chat style to return to when leaving Agent. */
  const lastChatStyleRef = useRef<ChatMode>(initialMode !== "agent" && !isTemporary ? initialMode : "general");

  // --- capability selection (secondary; lives in the top bar / settings) ---
  // Model choice lives in the Models selector (saved per account); the lane
  // stays automatic so routing follows that pool.
  const lane: ModelLane = "auto";
  const [revealMode, setRevealMode] = useState<RevealMode>("adaptive");
  const revealModeRef = useRef<RevealMode>("adaptive");
  useEffect(() => {
    let active = true;
    // Shared with the Models selector: one request serves both.
    void loadModelPool().then((data) => {
      const saved = data?.reveal_mode as RevealMode | undefined;
      if (active && saved && ["adaptive", "word", "natural", "reduced"].includes(saved)) { setRevealMode(saved); revealModeRef.current = saved; }
    });
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
  // "Awaiting approval": executable work requested in a conversation mode.
  const [handoff, setHandoff] = useState<PendingHandoff | null>(null);
  const lastBuildIntentRef = useRef<BuildIntent | null>(null);
  const lastBuildWorkspaceOnlyRef = useRef(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  // Restore live project workspace files and interrupted session notice when reopening an Agent Mode conversation.
  useEffect(() => {
    if (isTemporary || mode !== "agent") return;
    let cancelled = false;
    if (agentProjectId) {
      void rpc<{ files: Array<{ path: string; content: string; language?: string }> }>("project_get", { id: agentProjectId })
        .then((res) => {
          if (cancelled || !Array.isArray(res?.files) || res.files.length === 0) return;
          setAgentFiles(res.files.map((f) => ({
            path: f.path,
            content: f.content,
            language: f.language ?? languageForPath(f.path),
          })));
        })
        .catch(() => { /* project may not exist or be inaccessible; keep message artifacts */ });
    }
    if (initialExecutionState && ["RUNNING", "PLANNING", "EDITING", "TESTING"].includes(initialExecutionState)) {
      setNotice(
        `Previous agent session${initialAgentSessionId ? ` (${initialAgentSessionId.slice(0, 8)})` : ""} ended before completing (${initialExecutionState}). Your conversation and project workspace are restored — send a message to continue.`
      );
    }
    return () => { cancelled = true; };
  // Run once on mount when reopening a persisted conversation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // --- speech: QORVYNA reading an answer aloud --------------------------------
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  // --- voice messages: dictation (Mode A default) + hands-free (Mode B) ---
  const [voiceLang, setVoiceLangState] = useState("auto");
  const voiceLangRef = useRef("auto");
  const [voiceMode, setVoiceModeState] = useState<VoiceInputMode>("dictate");
  const voiceModeRef = useRef<VoiceInputMode>("dictate");
  /** A voice message is uploading / being transcribed before it is sent. */
  const [voiceSending, setVoiceSending] = useState(false);
  const voiceAbortRef = useRef<AbortController | null>(null);
  /** "Transcribe" is turning a recording into composer text (nothing is sent). */
  const [transcribing, setTranscribing] = useState(false);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  /** A dictation that could not be transcribed, kept so it can be tried again. */
  const [dictationRetry, setDictationRetry] = useState<{ clip: VoiceClip; message: string } | null>(null);
  /** This session's recordings by turn id: local playback, retry, attachments. */
  const voiceDraftsRef = useRef<Map<string, { clip: VoiceClip; attachments: PendingAttachment[]; assetId: string | null }>>(new Map());
  const recorder = useVoiceRecorder({
    language: voiceLang,
    silenceStopMs: voiceMode === "hands_free" ? 1400 : null,
    onAutoStop: (capture, reason) => {
      if (reason === "silence" && voiceModeRef.current === "hands_free") {
        handleVoiceCapture(capture, "hands_free_send");
        return;
      }
      handleVoiceCapture(capture, "hold", reason === "limit"
        ? "Recording stopped at the 10-minute limit."
        : "The microphone was disconnected before you finished.");
    },
  });
  /** Anything in flight: the composer's primary button becomes Stop. */
  const busy = streaming || voiceSending;
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY);
      if (saved) { const code = voiceLanguage(saved).code; voiceLangRef.current = code; setVoiceLangState(code); }
      const savedMode = window.localStorage.getItem(VOICE_MODE_STORAGE_KEY);
      if (savedMode) { const nextMode = normalizeVoiceInputMode(savedMode); voiceModeRef.current = nextMode; setVoiceModeState(nextMode); }
    } catch { /* private mode: defaults are used */ }
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
    // The recorder releases the microphone itself (use-voice-recorder).
    generatedAudioRef.current?.pause();
    if (generatedAudioUrlRef.current) URL.revokeObjectURL(generatedAudioUrlRef.current);
    voiceAbortRef.current?.abort();
    transcribeAbortRef.current?.abort();
    for (const draft of voiceDraftsRef.current.values()) URL.revokeObjectURL(draft.clip.url);
    voiceDraftsRef.current.clear();
  }, []);
  useEffect(() => { localeRef.current = locale; }, [locale]);

  const authLifecycle = useAuthLifecycle();
  const [sessionInitError, setSessionInitError] = useState<string | null>(null);
  const chatInitializedRef = useRef(false);

  // The composer sits on the keyboard; the bottom navigation steps aside.
  useKeyboardInset();

  // An unsent draft survives a refresh (per conversation, this tab only).
  const draftKey = `${DRAFT_PREFIX}${isTemporary ? "temporary" : convId ?? "new"}`;

  useEffect(() => {
    if (!firebaseBrowserConfigured) return;
    let cancelled = false;

    const finalizeChatInit = (authMode: string, profileLoaded: boolean) => {
      if (cancelled) return;
      setSessionInitError(null);
      if (!chatInitializedRef.current) {
        chatInitializedRef.current = true;
        logAuthEvent("CHAT_INITIALIZATION", {
          stage: "chat-load",
          method: "session",
          detail: {
            sessionReady: true,
            profileLoaded,
            authMode,
            conversation: convIdRef.current ?? "new",
            mode,
          },
        });
        try {
          const saved = window.sessionStorage.getItem(draftKey);
          if (saved) setInput((current) => current || saved);
          else {
            void loadDraft(draftKey).then((idbDraft) => {
              if (idbDraft) setInput((current) => current || idbDraft);
            });
          }
        } catch {
          void loadDraft(draftKey).then((idbDraft) => {
            if (idbDraft) setInput((current) => current || idbDraft);
          });
        }
      }
    };

    if (authLifecycle.status === "INITIALIZING" || authLifecycle.status === "PROFILE_LOADING") {
      return;
    }
    if (authLifecycle.status === "READY") {
      if (authLifecycle.profileLoaded === false) {
        setSessionInitError("Signed in, but your user profile could not be loaded. Tap Retry to reload your session.");
        return;
      }
      finalizeChatInit("lifecycle", authLifecycle.profileLoaded);
      return;
    }
    if (authLifecycle.status === "ERROR") {
      logAuthEvent("CHAT_INITIALIZATION", {
        stage: "chat-load",
        method: "session",
        detail: {
          sessionReady: false,
          failedStage: authLifecycle.error?.stage ?? "unknown",
        },
      });
      setSessionInitError(authLifecycle.error?.message ?? "Your session could not be verified. Tap Retry.");
      return;
    }

    // UNAUTHENTICATED in Firebase client (e.g., cookie-only SSR or signed out in
    // another tab): verify backend auth independently before initializing chat.
    void (async () => {
      logAuthEvent("BACKEND_AUTH_CHECK", {
        stage: "session-check",
        method: "session",
        detail: { caller: "chat-init" },
      });
      try {
        const res = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (cancelled) return;
        const data = (await res.json().catch(() => ({}))) as {
          authenticated?: boolean;
          profile_loaded?: boolean;
        };
        if (res.ok && data.authenticated) {
          if (data.profile_loaded === false) {
            setSessionInitError("Signed in, but your user profile failed to load. Tap Retry.");
            return;
          }
          finalizeChatInit("cookie", true);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      logAuthEvent("CHAT_INITIALIZATION", {
        stage: "chat-load",
        method: "session",
        detail: { sessionReady: false, reason: "backend-unauthenticated" },
      });
      setSessionInitError("Your session could not be verified by the server. Sign in again to continue.");
    })();

    return () => {
      cancelled = true;
    };
  }, [authLifecycle.status, authLifecycle.profileLoaded, authLifecycle.error, draftKey, mode]);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        if (input.trim()) window.sessionStorage.setItem(draftKey, input.slice(0, 12_000));
        else window.sessionStorage.removeItem(draftKey);
      } catch { /* storage unavailable */ }
      if (!isTemporary) {
        if (input.trim()) void saveDraft(draftKey, input.slice(0, 12_000));
        else void clearDraft(draftKey);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [input, draftKey, isTemporary]);

  useEffect(() => {
    if (isTemporary || !convId || !messages.length) return;
    const handle = window.setTimeout(() => {
      void saveCachedConversation({
        id: convId,
        title: title || "Conversation",
        mode,
        updatedAt: Date.now(),
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at ?? new Date().toISOString(),
        })),
      });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [convId, isTemporary, messages, mode, title]);

  useEffect(() => {
    if (isTemporary || typeof window === "undefined") return;
    const handleOnline = async () => {
      const queued = await listOutboxMessages();
      const matching = queued.filter((item) => item.conversationId === convIdRef.current);
      if (!matching.length) return;
      const failedSet = new Set(
        messagesRef.current
          .filter((m) => m.role === "user" && m.metadata?.send_failed)
          .map((m) => m.content),
      );
      let stillPending = 0;
      for (const entry of matching) {
        if (failedSet.has(entry.text)) stillPending += 1;
        else await removeOutboxMessage(entry.id);
      }
      if (stillPending > 0) {
        setNotice(`Back online — ${stillPending} offline message${stillPending > 1 ? "s" : ""} saved. Tap Retry on the message to send.`);
      }
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [isTemporary]);

  const chatScroll = useChatScroll(scrollAreaRef, scrollContentRef, `${messages.length}:${buildRun?.updatedAt ?? 0}:${liveSteps.length}:${streamCommitted}:${editingKey ?? ""}`);

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
        title: firstHeading(message.content, "QORVYNA response"),
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

  function rememberConv(id: string | null) {
    if (!id || convIdRef.current === id) return;
    convIdRef.current = id;
    setConvId(id);
    // The server titles a new conversation from its first message; mirror it.
    setTitle((current) => current || (messagesRef.current.find((item) => item.role === "user")?.content ?? "").replace(/\s+/g, " ").slice(0, 60));
    onConversationCreated?.(id);
  }

  /**
   * Chat ⇄ Agent (and the chat styles) switch INSIDE the conversation: same
   * id, same history, same draft and attachments. Only how the next message
   * is handled changes — nothing is reloaded and nothing is lost.
   */
  function switchMode(next: ChatMode) {
    if (next === mode || isTemporary || streaming || voiceSending || recorder.state !== "idle") return;
    stopSpeech();
    stopGeneratedSpeech();
    setSpeakingId(null);
    if (next !== "agent") lastChatStyleRef.current = next;
    setMode(next);
    setModeHint(null);
    setFailure(null);
    setNotice(null);
    setExportPickerKey(null);
    setHandoff(null);
    const id = convIdRef.current;
    if (id) {
      // Remembered so a reload reopens this conversation in the same mode.
      void rpc("conversation_update", { id, mode: next }).catch(() => {});
    } else if (!isTemporary && typeof window !== "undefined" && window.location.pathname === "/chat") {
      // A new chat keeps its mode in the address bar WITHOUT a navigation —
      // navigating would remount this screen and drop what is being written.
      window.history.replaceState(null, "", `/chat?mode=${next}`);
    }
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
        completeArtifact(beginArtifact(requestArtifact(current, { type: "IMAGE", title: "QORVYNA image" })), "qorvyna-image.png"),
      );
      return;
    }
    const format = intent.formats[0];
    if (!format) return;
    // "Turn THIS answer into a PDF" refers to the previous answer; "create a
    // CSV from this table" refers to the table in the reply that just arrived.
    const previous = lastAssistantContent(messagesRef.current);
    const content = pickArtifactContent({ format, reply, previous });
    void buildArtifactFor(key, format, content, firstHeading(content, "QORVYNA response"));
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  function commitPartial(
    text: string,
    opts: { replaceLastAssistant?: boolean; turnId?: string; intent?: IntentResult; id?: string | null; versions?: ReplyVersion[] } = {},
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
      const tail = current[current.length - 1];
      // Regenerate / Edit & resend: the new answer takes the place of the old
      // one (same stored message), and the old one is kept as a version.
      const replaced = opts.replaceLastAssistant && tail?.role === "assistant" ? tail : undefined;
      const base = replaced ? current.slice(0, -1) : current;
      const last = base[base.length - 1];
      if (!replaced && last?.role === "assistant" && last.content === reply) {
        // Identical reply (a retry that produced the same text): keep one
        // message but stamp this turn's metadata so its key still matches the
        // artifact/execution state built for it.
        return [...base.slice(0, -1), { ...last, id: opts.id ?? last.id, metadata: { ...last.metadata, ...metadata } }];
      }
      const versions = opts.versions?.length ? opts.versions : versionsAfterReplace(replaced);
      return [...base, {
        id: opts.id ?? replaced?.id,
        role: "assistant" as const,
        content: reply,
        created_at: new Date().toISOString(),
        metadata: versions.length ? { ...metadata, versions } : metadata,
      }];
    });
    return key;
  }

  /** The composer's Stop button: whatever is in flight ends cleanly. */
  function stop() {
    clearIdleTimer();
    // A voice message that is still uploading: cancel it and keep the recording.
    if (voiceAbortRef.current) { voiceAbortRef.current.abort(); return; }
    const building = Boolean(buildControllerRef.current);
    abortRef.current?.abort(new DOMException("Stopped by user.", "AbortError"));
    buildControllerRef.current?.abort(new DOMException("Stopped by user.", "AbortError"));
    setStreaming(false);
    // A streamed answer keeps what already arrived (see streamMessage). A build
    // cannot be un-started from here, and saying otherwise would be untrue.
    if (building) setNotice("Stopped watching this build. If it was already publishing it keeps running on the server — open the project to see its real state.");
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
        voiceName: jarvisSettingsRef.current.voiceName || undefined,
        rate: jarvisSettingsRef.current.speechRate,
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
      voiceName: jarvisSettingsRef.current.voiceName || undefined,
      rate: jarvisSettingsRef.current.speechRate,
      onend: () => setSpeakingId((current) => (current === "auto" ? null : current)),
      onerror: () => setSpeakingId((current) => (current === "auto" ? null : current)),
    });
    setSpeakingId(ok ? "auto" : null);
  }

  // -------------------------------------------------------------------------
  // Voice messages
  //
  //   mic → recording (live waveform, timer) → [Stop] → the recording appears
  //   in the conversation as a voice message and is sent. No extra Send click.
  //
  // [Transcribe] is a separate action: it turns the recording into editable
  // text in the composer and sends nothing. QORVYNA reading an answer aloud
  // (listenTo above) is speech synthesis and unrelated to both.
  // -------------------------------------------------------------------------

  function setVoiceLang(code: string) {
    const next = voiceLanguage(code).code;
    voiceLangRef.current = next;
    setVoiceLangState(next);
    try { window.localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, next); } catch { /* not persisted */ }
  }

  function changeVoiceMode(next: VoiceInputMode) {
    const normalized = normalizeVoiceInputMode(next);
    voiceModeRef.current = normalized;
    setVoiceModeState(normalized);
    try { window.localStorage.setItem(VOICE_MODE_STORAGE_KEY, normalized); } catch { /* not persisted */ }
  }

  /** Put recognised words into the composer as ordinary, editable text. */
  function placeTranscript(text: string) {
    setInput((current) => mergeTranscript(current, text));
    setNotice(null);
    requestAnimationFrame(() => {
      const field = textareaRef.current;
      if (field) { field.focus(); const end = field.value.length; try { field.setSelectionRange(end, end); } catch { /* unsupported input type */ } }
    });
  }

  type TranscriptResult =
    | { ok: true; transcript: string; assetId: string | null; language: string | null }
    | { ok: false; message: string; assetId: string | null; aborted: boolean };

  /**
   * Send a recording to the speech service (Whisper; the language is detected
   * unless one was chosen). `store` keeps the original audio with the account
   * so the voice message can be played back later.
   */
  async function requestTranscript(clip: VoiceClip, options: { store: boolean; signal: AbortSignal; retryAssetId?: string | null }): Promise<TranscriptResult> {
    try {
      const form = new FormData();
      if (options.retryAssetId) form.append("audio_asset_id", options.retryAssetId);
      else {
        form.append("audio", clip.blob, clip.filename);
        form.append("duration_ms", String(clip.durationMs));
        form.append("waveform", clip.waveform.join(","));
      }
      form.append("language", voiceLangRef.current);
      form.append("store", options.store ? "1" : "0");
      const response = await fetch("/api/voice/transcribe", { method: "POST", credentials: "same-origin", body: form, signal: options.signal });
      const data = await response.json().catch(() => ({})) as { transcript?: string; audio_asset_id?: string | null; detected_language?: string | null; error?: string };
      const assetId = typeof data.audio_asset_id === "string" && data.audio_asset_id ? data.audio_asset_id : null;
      const transcript = data.transcript?.trim() ?? "";
      if (!response.ok || !transcript) {
        return { ok: false, message: voiceErrorMessage(response.ok ? "EMPTY_TRANSCRIPT" : String(data.error ?? response.status)), assetId, aborted: false };
      }
      return { ok: true, transcript, assetId, language: data.detected_language ?? null };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false, assetId: null, aborted,
        message: aborted ? "Sending was cancelled." : navigator.onLine === false ? "You are offline. Reconnect and try again." : "The recording could not be uploaded. Check your connection and try again.",
      };
    }
  }

  async function startVoice() {
    if (recorder.state !== "idle" || transcribing || busy) return;
    // QORVYNA must not record its own voice.
    stopSpeech();
    stopGeneratedSpeech();
    setSpeakingId(null);
    setNotice(null);
    setComposerError(null);
    const started = await recorder.start();
    if (!started.ok) setComposerError(started.message);
  }

  /** Mode A: Stop → transcribe into composer. Mode B: transcribe & send. Clip: voice message. */
  async function finishVoice(intent: "send" | "transcribe" | "hands_free_send") {
    handleVoiceCapture(await recorder.stop(), intent);
  }

  function cancelVoice() {
    recorder.cancel();
    setNotice("Recording discarded. Nothing was sent.");
  }

  function handleVoiceCapture(capture: VoiceCapture | null, intent: "send" | "transcribe" | "hands_free_send" | "hold", holdReason?: string) {
    if (!capture) { setComposerError("No audio was captured. Check the microphone and try again."); return; }
    // A browser without a recorder can only give words.
    if (capture.kind === "transcript") {
      if (intent === "hands_free_send") void send(undefined, capture.text);
      else placeTranscript(capture.text);
      return;
    }
    const clip = capture.clip;
    if (clip.durationMs < MIN_RECORDING_MS) { URL.revokeObjectURL(clip.url); setComposerError("That recording was too short. Record a little longer."); return; }
    if (!clip.hadSpeech && !clip.heard) {
      URL.revokeObjectURL(clip.url);
      setComposerError(voiceErrorMessage("SILENT_RECORDING"));
      return;
    }
    if (clip.blob.size > MAX_AUDIO_BYTES) { URL.revokeObjectURL(clip.url); setComposerError("That recording is too large to send. Record a shorter message."); return; }
    if (intent === "transcribe") { void transcribeToComposer(clip); return; }
    if (intent === "hands_free_send") { void transcribeAndSendTurn(clip); return; }

    // Explicit audio clip message (`Clip` button): playable in conversation.
    const turnId = crypto.randomUUID();
    const pending = attachments;
    voiceDraftsRef.current.set(turnId, { clip, attachments: pending, assetId: null });
    setAttachments([]);
    setMessages((current) => [...current, {
      role: "user",
      content: "",
      created_at: new Date().toISOString(),
      metadata: {
        mode,
        turn_id: turnId,
        audio_duration_ms: clip.durationMs,
        audio_waveform: clip.waveform,
        local_audio_url: clip.url,
        attachment_names: pending.map((file) => file.name),
        ...(intent === "hold"
          ? { voice_status: "failed" as const, voice_error: holdReason ?? "The recording stopped early." }
          : { voice_status: "processing" as const }),
      },
    }]);
    chatScroll.follow();
    if (intent === "send") void sendVoiceMessage(turnId);
  }

  function patchVoice(turnId: string, content: string | null, metadata: Partial<MessageMetadata>) {
    setMessages((current) => patchTurnMessage(current, "user", turnId, (message) => ({
      ...message, content: content ?? message.content, metadata: { ...message.metadata, ...metadata },
    })));
  }

  /** Upload + transcribe a recorded voice message, then send it. Also "Try again". */
  async function sendVoiceMessage(turnId: string) {
    const draft = voiceDraftsRef.current.get(turnId);
    if (!draft || voiceAbortRef.current || requestInFlightRef.current) return;
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    setVoiceSending(true);
    setFailure(null);
    patchVoice(turnId, null, { voice_status: "processing", voice_error: undefined });
    // Temporary chats keep nothing, so their audio is transcribed and dropped.
    const result = await requestTranscript(draft.clip, { store: !isTemporary, signal: controller.signal, retryAssetId: draft.assetId });
    voiceAbortRef.current = null;
    setVoiceSending(false);

    let transcript = "";
    let assetId: string | null = null;
    let language: string | null = null;
    if (result.ok) {
      transcript = result.transcript; assetId = result.assetId; language = result.language;
    } else if (!result.aborted && draft.clip.heard) {
      // The speech service failed, but the browser heard the words itself.
      transcript = draft.clip.heard;
    } else {
      if (result.assetId) draft.assetId = result.assetId;
      patchVoice(turnId, null, { voice_status: "failed", voice_error: result.message });
      return;
    }
    draft.assetId = assetId;
    patchVoice(turnId, transcript, {
      voice_status: undefined, voice_error: undefined, audio_language: language,
      ...(assetId ? { audio_asset_id: assetId } : {}),
    });
    // The transcript is the request; the recording stays attached to it.
    await send(undefined, transcript, { voice: { turnId, assetId, attachments: draft.attachments } });
  }

  function discardVoice(turnId: string) {
    const draft = voiceDraftsRef.current.get(turnId);
    if (draft) {
      URL.revokeObjectURL(draft.clip.url);
      // Files that were waiting with the recording go back to the composer.
      if (draft.attachments.length) setAttachments((current) => (current.length ? current : draft.attachments));
      if (draft.assetId) void fetch(`/api/voice/audio/${encodeURIComponent(draft.assetId)}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
      voiceDraftsRef.current.delete(turnId);
    }
    setMessages((current) => current.filter((message) => !(message.role === "user" && message.metadata?.turn_id === turnId)));
  }

  /** Mode A (default): transcribe into editable composer text — never auto-sends. */
  async function transcribeToComposer(clip: VoiceClip) {
    if (transcribing) return;
    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    setTranscribing(true);
    setDictationRetry(null);
    setComposerError(null);
    const result = await requestTranscript(clip, { store: false, signal: controller.signal });
    transcribeAbortRef.current = null;
    setTranscribing(false);
    if (result.ok) { placeTranscript(result.transcript); URL.revokeObjectURL(clip.url); return; }
    if (!result.aborted && clip.heard) { placeTranscript(clip.heard); URL.revokeObjectURL(clip.url); return; }
    if (result.aborted) { URL.revokeObjectURL(clip.url); setNotice("Transcription cancelled."); return; }
    // Nothing is lost: the recording waits here until it is retried or discarded.
    setDictationRetry({ clip, message: result.message });
  }

  /** Mode B (opt-in Hands-free): transcribe and immediately send as text. */
  async function transcribeAndSendTurn(clip: VoiceClip) {
    if (transcribing || busy) return;
    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    setTranscribing(true);
    setDictationRetry(null);
    setComposerError(null);
    const result = await requestTranscript(clip, { store: false, signal: controller.signal });
    transcribeAbortRef.current = null;
    setTranscribing(false);
    const spoken = result.ok ? result.transcript : (!result.aborted && clip.heard ? clip.heard : "");
    if (spoken) {
      URL.revokeObjectURL(clip.url);
      if (!input.trim() && jarvisDispatchRef.current) {
        await jarvisDispatchRef.current(spoken);
        return;
      }
      const combined = mergeTranscript(input, spoken);
      setInput("");
      await send(undefined, combined);
      return;
    }
    if (!result.ok && result.aborted) { URL.revokeObjectURL(clip.url); setNotice("Hands-free turn cancelled."); return; }
    setDictationRetry({ clip, message: result.ok ? voiceErrorMessage("NO_SPEECH_DETECTED") : result.message });
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
      // The answer being replaced steps aside while the new one streams in; it
      // comes back untouched if nothing arrives.
      const shown = messagesRef.current;
      const tail = shown.length - 1;
      if (tail >= 0 && shown[tail].role === "assistant") setHiddenKey(messageKey(shown[tail], tail));
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
      setFailure({ ...failureCopy("not-configured"), detail: "The QORVYNA backend is not configured on this deployment yet, so chat cannot start." });
      setStreaming(false);
      setStreamedText(null);
      setHiddenKey(null);
      requestInFlightRef.current = false;
      return;
    }

    // Wait briefly for startup auth lifecycle / Firebase hydration before sending
    // so both the __session cookie and optional Bearer ID token are ready.
    if (authLifecycle.status === "INITIALIZING" || authLifecycle.status === "PROFILE_LOADING") {
      await Promise.race([
        startAuthLifecycle(),
        waitForAuthUser(2500),
      ]).catch(() => {});
    }
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
    // Server ids make a just-sent turn editable, deletable and retryable
    // without a reload; versions come back when an answer was replaced.
    let replyId: string | null = null;
    let replyVersions: ReplyVersion[] | undefined;
    let userStored = opts.reuseUser === true || opts.regenerate === true;
    let storedUserId: string | null = null;
    // Set when the server answers "this is executable Agent work": the turn is
    // then carried out by the build pipeline instead of ending as an error.
    let executeInstead = false;
    const noteStored = (userMessageId?: unknown) => {
      userStored = true;
      if (lastTurnRef.current?.turnId === turnId) lastTurnRef.current.stored = true;
      if (!isTemporary) {
        void listOutboxMessages().then((queued) =>
          Promise.all(
            queued
              .filter((entry) => entry.conversationId === convIdRef.current && entry.text === message)
              .map((entry) => removeOutboxMessage(entry.id)),
          ),
        );
      }
      if (typeof userMessageId !== "string" || !userMessageId || storedUserId === userMessageId) return;
      storedUserId = userMessageId;
      setMessages((current) => patchTurnMessage(current, "user", turnId, (item) => ({ ...item, id: userMessageId, metadata: { ...item.metadata, send_failed: undefined } })));
    };
    /** The request never reached the conversation: the bubble says so. */
    const noteUnsent = () => {
      if (userStored) return;
      setMessages((current) => patchTurnMessage(current, "user", turnId, (item) => ({ ...item, metadata: { ...item.metadata, send_failed: true } })));
    };

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
      const key = commitPartial(text, { replaceLastAssistant, turnId, intent, id: replyId, versions: replyVersions }, streamMetadata);
      if (key) { committedKey = key; setSettledKey(key); }
      committed = true;
      // An artifact the user explicitly asked for is built once the reply lands.
      if (key && !isImage) requestArtifactFromIntent(key, intent, text);
      if (key && isImage && streamMetadata.image_data_url) {
        updateArtifact(key, (current) =>
          completeArtifact(beginArtifact(requestArtifact(current, { type: "IMAGE", title: "QORVYNA image" })), "qorvyna-image.png"),
        );
      }
    };

    try {
      armIdleTimer(isAgentRun ? 180_000 : CONNECT_TIMEOUT_MS, controller);
      const requestBody = JSON.stringify({
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
      });
      const postAi = async (forceRefresh = false) =>
        fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await optionalAuthHeaders(forceRefresh)) },
          credentials: "same-origin",
          body: requestBody,
          signal: controller.signal,
        });

      let res = await postAi(false);
      if (res.status === 401 && fbAuth().currentUser) {
        await mintSessionCookie(undefined, { forceRefresh: true }).catch(() => {});
        res = await postAi(true);
      }
      armIdleTimer(STREAM_IDLE_TIMEOUT_MS, controller);

      if (!res.ok) {
        clearIdleTimer();
        const gatewayError = await parseGatewayError(res);
        if (gatewayError.conversationId) rememberConv(gatewayError.conversationId);
        if (gatewayError.userMessageId) noteStored(gatewayError.userMessageId);
        else noteUnsent();
        // AGENT_RUNTIME_REQUIRED is not a failure to show the user. The server
        // refused to answer executable work with words; the same turn is handed
        // to the real pipeline (see `finally` below).
        if (res.status === 409 && gatewayError.code === "AGENT_RUNTIME_REQUIRED" && (messageMode === "agent" || messageMode === "code")) {
          executeInstead = true;
          return;
        }
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
          message_id?: string;
          user_message_id?: string;
          versions?: ReplyVersion[];
        };
        noteStored(data.user_message_id);
        if (typeof data.message_id === "string") replyId = data.message_id;
        if (Array.isArray(data.versions)) replyVersions = data.versions;
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
        setFailure(withRequestReference(failureCopy("server"), res.headers.get("X-QORVYNA-Request-ID")));
        return;
      }

      const sseRequestId = res.headers.get("X-QORVYNA-Request-ID");
      const reader = res.body?.getReader();
      if (!reader) {
        clearIdleTimer();
        setFailure(withRequestReference(failureCopy("server"), res.headers.get("X-QORVYNA-Request-ID")));
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
        message_id?: string;
        user_message_id?: string;
        versions?: ReplyVersion[];
      };

      const handleEvent = (data: StreamEvent) => {
        if (data.user_message_id) noteStored(data.user_message_id);
        if (typeof data.message_id === "string") replyId = data.message_id;
        if (Array.isArray(data.versions)) replyVersions = data.versions;
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
          noteStored();
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

      // The stream ended without its final event: what arrived is kept and
      // marked, so the row offers "Try again" instead of looking complete.
      if (!committed && collected.trim() && streamError) streamMetadata.interrupted = true;
      if (!committed && collected.trim()) {
        commit(collected);
        maybeAutoSpeak(collected);
        void notifyWorkDone({
          title: "QORVYNA finished responding",
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
        // Stop, a timeout or a dropped connection: keep what already arrived.
        streamMetadata.interrupted = true;
        commit(collected);
      } else if (!committed) {
        noteUnsent();
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
      setHiddenKey(null);
      abortRef.current = null;
      requestInFlightRef.current = false;
      setStreamStatus(null);
      if (executeInstead) {
        void runBuildTurn(
          message,
          { ...NO_BUILD_INTENT, build: true, preview: true, explicit: true, signals: ["server required the Agent runtime"] },
          turnId, sentAttachments, messageMode === "code", null, undefined,
          { reuseUser: userStored, audioAssetId: opts.audioAssetId ?? null },
        );
      }
    }
  }

  /** Approve a pending hand-off: the request runs for real, in Agent mode. */
  function approveHandoff() {
    const pending = handoff;
    if (!pending || streaming) return;
    setHandoff(null);
    // The conversation continues in Agent mode so follow-up instructions
    // ("now make the header blue") run directly.
    switchMode("agent");
    const intent: BuildIntent = { ...pending.intent, preview: pending.intent.preview || (pending.intent.build && !pending.intent.publish) };
    void runBuildTurn(pending.message, intent, pending.turnId, pending.attachments, false, null, undefined, { reuseUser: pending.reuseUser, audioAssetId: pending.audioAssetId });
  }

  /**
   * A chat reply described work it could not have done. Carry out the request
   * above it for real: same conversation, the prompt already in the thread.
   */
  function runLatestRequestWithAgent() {
    if (streaming || isTemporary) return;
    const list = messagesRef.current;
    let request: ChatMessage | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "user") { request = list[i]; break; }
    }
    const prompt = request?.content.trim();
    if (!prompt) return;
    if (requestsClarificationFirst(prompt)) {
      // The request asks to be questioned first: that is a conversation in
      // Agent mode, not a run.
      switchMode("agent");
      setNotice("Switched to Agent. Send the request again and the Agent will ask its question first, then do the work.");
      return;
    }
    const detected = detectBuildIntent(prompt, { mode: "agent", agentMode: true, projectFileCount: agentFiles.length || (agentProjectId ? 1 : 0), priorPlan: lastAssistantContent(list) });
    const intent: BuildIntent = shouldRunBuildPipeline(detected)
      ? detected
      : { ...NO_BUILD_INTENT, build: true, preview: true, explicit: true, signals: ["run with Agent requested from a chat reply"] };
    switchMode("agent");
    void runBuildTurn(prompt, intent, crypto.randomUUID(), [], false, null, undefined, { reuseUser: Boolean(request?.id) || Boolean(convIdRef.current) });
  }

  /** Decline the hand-off: the same message gets a conversation answer. */
  function answerHandoffInChat() {
    const pending = handoff;
    if (!pending || streaming) return;
    setHandoff(null);
    void send(undefined, pending.message, pending.audioAssetId
      ? { chatOnly: true, voice: { turnId: pending.turnId, assetId: pending.audioAssetId, attachments: pending.attachments } }
      : { chatOnly: true, resend: { turnId: pending.turnId, stored: pending.reuseUser, replaceReply: false, attachments: pending.attachments } });
  }

  /** Dismissed without a decision: the message was never sent anywhere. */
  function dismissHandoff() {
    const pending = handoff;
    if (!pending) return;
    setHandoff(null);
    if (!pending.reuseUser) {
      setMessages((current) => patchTurnMessage(current, "user", pending.turnId, (item) => ({ ...item, metadata: { ...item.metadata, send_failed: true } })));
    }
  }

  async function send(e?: { preventDefault(): void }, messageOverride?: string, turn: TurnOptions = {}) {
    e?.preventDefault();
    // A voice message, an edited message or a retry already has its bubble.
    const existing = turn.voice ?? turn.resend ?? null;
    const fromComposer = !messageOverride && !existing;
    const pending = existing ? existing.attachments : fromComposer ? attachments : [];
    const attachedImage = fromComposer ? pendingImage : null;
    const audioAssetId = turn.voice?.assetId ?? null;
    // Edit & resend / Retry: the prompt is already stored — never store it twice —
    // and the answer under it is replaced in place rather than duplicated.
    const reuseUser = turn.resend?.stored === true;
    const replaceReply = turn.resend?.replaceReply === true;
    const flow = { reuseUser, regenerate: replaceReply && reuseUser, replaceLastAssistant: replaceReply };
    const buildFlow = { reuseUser, audioAssetId };
    let message =
      (messageOverride ?? input).trim() ||
      (attachedImage ? "Analyse this attached image clearly and thoroughly." : pending.length ? "Review these attached files and help me with them." : "");
    // One request at a time: a fast Enter + click can never send twice.
    if (!message || streaming || uploadingImage || requestInFlightRef.current || recorder.state !== "idle") return;
    // Composer capabilities are opt-in hints, never automatic invocations.
    const rawMessage = message;
    if (fromComposer) {
      if (webSearch) message = `Use up-to-date public knowledge where it helps.\n\n${message}`;
      if (codeHint) message = `Answer with complete, runnable code when it helps.\n\n${message}`;
      // What was written now lives in the conversation: the bubble keeps the
      // text and its files, and Retry / Edit resend them if the request fails.
      setInput("");
      setAttachments([]);
      if (attachedImage) {
        URL.revokeObjectURL(attachedImage.previewUrl);
        setPendingImage(null);
      }
    }
    setComposerError(null);
    setEditingKey(null);
    // A new message supersedes a request that was waiting for approval.
    if (handoff && handoff.turnId !== existing?.turnId) dismissHandoff();
    lastAttachmentsRef.current = pending;
    lastImagePathRef.current = attachedImage?.storagePath ?? null;

    // --- intent detection happens on the user's own words -----------------
    const intent = detectIntent(rawMessage, {
      mode,
      codeCapability: codeHint || mode === "code",
      agentMode: mode === "agent",
    });
    const turnId = existing?.turnId ?? crypto.randomUUID();
    lastTurnRef.current = { turnId, stored: reuseUser, audioAssetId };
    if (existing) {
      setMessages((current) => patchTurnMessage(current, "user", turnId, (item) => ({
        ...item, metadata: { ...item.metadata, mode, intent: intent.intent, artifact_type: intent.artifact, send_failed: undefined },
      })));
    } else {
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
          attachment_names: allAttachmentNames,
          intent: intent.intent,
          artifact_type: intent.artifact,
          turn_id: turnId,
        },
      }]);
    }
    // Sending is a deliberate act: the conversation follows the new turn.
    chatScroll.follow();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (!isTemporary) {
        void enqueueOutboxMessage({ conversationId: convIdRef.current, text: message, mode });
      }
      setMessages((current) => patchTurnMessage(current, "user", turnId, (item) => ({ ...item, metadata: { ...item.metadata, send_failed: true } })));
      setNotice("You're offline — your message was saved locally. Reconnect and tap Retry.");
      return;
    }
    const hinted = suggestMode(rawMessage, mode);
    if (hinted && hinted !== effectiveMode(intent, mode)) setModeHint(hinted);
    if (mode === "orchestrator") setGraphNodes(planOrchestrator(rawMessage).map((task) => ({ id: task.id, title: task.title, status: "running" as const })));
    // The user already chose a conversation answer for this request.
    if (turn.chatOnly) {
      await streamMessage(message, { attachments: pending, imageStoragePath: null, intent, turnId, audioAssetId, ...flow });
      return;
    }

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
            const res = await fetch("/api/ai", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(await optionalAuthHeaders()) },
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
        await runBuildTurn(resumedTaskPrompt(updated, rawMessage), detectBuildIntent(updated.originalRequest, { mode: "agent", agentMode: true, projectFileCount: agentFiles.length || (agentProjectId ? 1 : 0) }), turnId, pending, false, updated, rawMessage, buildFlow);
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
      await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId, ...flow, taskContext: context });
      return;
    }
    if (mode === "agent" && requestsClarificationFirst(rawMessage)) {
      const task: PendingAgentTask = { originalRequest: rawMessage, clarifications: [], state: "CLARIFICATION_REQUIRED", projectId: agentProjectId };
      await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId, ...flow, taskContext: task });
      return;
    }
    const buildIntent = detectBuildIntent(rawMessage, {
      mode,
      agentMode: mode === "agent",
      projectFileCount: agentFiles.length || (agentProjectId ? 1 : 0),
      priorPlan: lastAssistantContent(messages),
      hasAttachments: pending.length > 0,
    });
    // Real project work asked for in a conversation mode. A chat reply cannot
    // do it, and a reply that sounds as if it did would be untrue — so nothing
    // is sent to the model. The request waits for one tap: run it with the
    // Agent, or answer in chat instead. (Temporary chats keep nothing and so
    // cannot own a project; they stay conversational.)
    const handoffReason = !isTemporary && !attachedImage && isConversationMode(mode) && !requestsClarificationFirst(rawMessage)
      ? agentHandoffReason(rawMessage, buildIntent, { hasProject: Boolean(agentProjectId) || agentFiles.length > 0, hasAttachments: pending.length > 0 })
      : null;
    if (buildIntent.needsClarification && !handoffReason) {
      setNotice(buildIntent.clarification ?? "Describe what to build and I will create, validate and (if you ask) publish it.");
      await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId, ...flow,
        taskContext: mode === "agent" ? { originalRequest: rawMessage, clarifications: [], state: "CLARIFICATION_REQUIRED", projectId: agentProjectId } : null });
      return;
    }
    const codeWorkspaceRequest = mode === "code" && shouldCreateCodeWorkspace(rawMessage, pending);
    if (codeWorkspaceRequest && !buildIntent.publish && !buildIntent.preview) {
      await runBuildTurn(message, { ...buildIntent, build: true, publish: false, preview: false, fix: false }, turnId, pending, true, null, undefined, buildFlow);
      return;
    }
    if (mayExecuteAgent(mode, buildIntent) && shouldRunBuildPipeline(buildIntent)) {
      await runBuildTurn(message, buildIntent, turnId, pending, false, null, undefined, buildFlow);
      return;
    }
    if (handoffReason) {
      setHandoff({ turnId, message, rawMessage, intent: approvedIntent(buildIntent, handoffReason), reason: handoffReason, attachments: pending, audioAssetId, reuseUser });
      return;
    }
    await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId, ...flow });
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
    flow: { reuseUser?: boolean; audioAssetId?: string | null } = {},
  ) {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const selectedForThisRequest = taskContext?.projectId ?? (message === lastBuildPromptRef.current ? explicitAgentProjectIdRef.current : null);
    if (!selectedForThisRequest) explicitAgentProjectIdRef.current = null;
    lastBuildPromptRef.current = message;
    lastBuildTaskRef.current = taskContext;
    lastBuildVisibleRef.current = visibleMessage ?? null;
    lastBuildIntentRef.current = buildIntent;
    lastBuildWorkspaceOnlyRef.current = workspaceOnly;
    setHandoff(null);
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
        setFailure({ ...failureCopy("not-configured"), detail: "The QORVYNA backend is not configured on this deployment yet, so nothing can be built." });
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
          // Retry / Edit & resend: the prompt is already in this thread.
          reuseUser: flow.reuseUser === true && Boolean(convIdRef.current),
          // A voice message keeps its recording in Agent exactly as in Chat.
          audioAssetId: flow.audioAssetId ?? null,
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
      buildError = controller.signal.aborted
        ? { code: "", message: "Stopped before the build finished." }
        : err instanceof BuildRunError
        ? { code: err.code, message: err.detail ?? (err.code === "PROJECT_CONTEXT_MISSING" ? "This Chat is unavailable. Open a Chat you own and retry." : err.code === "PROJECT_STORAGE_UNAVAILABLE" ? "Project storage is unavailable. No build started; retry after Firestore is restored." : `The build service did not start this request (${err.code}).`) }
        : { code: "BUILD_UNREACHABLE", message: "QORVYNA could not reach the build service. Your message is safe — try again." };
      if (!(err instanceof Error && (err.name === "AbortError" || err instanceof BuildRunError))) console.error("[QORVYNA] build stream failed", err);
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

    // How the task ended, derived from the run record — never from prose.
    const requestError = buildError as { code: string; message: string } | null;
    const outcome = run ? outcomeOfRun(run) : requestError ? outcomeOfRequestError(requestError.code, requestError.message) : null;
    const replyText =
      settled.reply.trim() ||
      (run?.status === "succeeded"
        ? workspaceOnly
          ? `Wrote ${run.fileCount || artifacts.length} project file${(run.fileCount || artifacts.length) === 1 ? "" : "s"} to the workspace. Review the files there; build checks and deployment were not run.`
          : liveUrl
          ? `Built and published ${run.fileCount || artifacts.length || attachmentFiles.length} project file${run.fileCount === 1 ? "" : "s"}. The live address is below.`
          : `Build and validation passed. ${run.fileCount || artifacts.length} file${run.fileCount === 1 ? "" : "s"} are ready to preview.`
        : outcome && (outcome.state === "blocked" || outcome.state === "failed")
          ? `${outcome.label}: ${outcome.summary}${outcome.nextStep ? ` ${outcome.nextStep}` : ""}`
          : "QORVYNA stopped before the build finished. Open Deployment details to see where it ended.");

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

    if (lastTurnRef.current?.turnId === turnId && (run || settled.conversationId)) lastTurnRef.current.stored = true;
    if (controller.signal.aborted && !run) return;
    if (run?.status === "failed" || buildError) {
      const detail = run?.error?.message ?? buildError?.message ?? "The build stopped before publishing.";
      // The wall may be reported by the run or by the request that never became one.
      const stopCode = run?.error?.code ?? buildError?.code ?? "";
      if (stopCode === "PROJECT_AMBIGUOUS" || stopCode === "PROJECT_CONTEXT_MISSING") {
        // The owner-scoped list includes every selectable project, including
        // candidates beyond the short diagnostic stored in a build run.
        void rpc<Array<{ id: string; title: string }>>("project_list")
          .then(setProjectChoices).catch(() => setProjectChoices([]));
      }
      // Blocked is not failed: the same request would hit the same wall, so
      // the wall and what removes it are named instead of offering a retry.
      const blocked = outcome?.state === "blocked";
      // The reply above already says what happened, and a run that reached the
      // pipeline has its own card (state, evidence, Retry). The notice is only
      // for a request that never became a run and can simply be sent again —
      // saying the same thing a third time helps nobody.
      if (!run && !blocked) setFailure({ ...failureCopy("server"), title: "Build failed", detail, retryable: true });
    }
    if (run?.status === "succeeded") explicitAgentProjectIdRef.current = null;
    if (liveUrl && run) {
      setPublishPopup({ run, url: liveUrl, files: run.fileCount || artifacts.length });
      // Keep the live card visible for this turn only as long as the popup is
      // open; after it is dismissed the committed message row carries the link.
      setBuildRun(null);
      void notifyWorkDone({
        title: "QORVYNA published your build",
        body: `Live at ${liveUrl}`,
        link: liveUrl,
      });
    } else if (run?.status === "succeeded") {
      void notifyWorkDone({
        title: "QORVYNA build finished",
        body: `${run.fileCount || artifacts.length} project file(s) ready.`,
        link: projectId ? `/projects/${projectId}` : "/projects",
      });
    }
  }

  function retryBuild() {
    if (streaming) return;
    const prompt = lastBuildPromptRef.current;
    // After a reload nothing is remembered about the run, but the request is
    // still the last user message in the thread: send that again.
    if (!prompt) { void retry(); return; }
    // A failed CREATE may already have persisted its project. Retrying must
    // continue that ID, not create another copy in the same chat.
    if (buildRun?.projectId) explicitAgentProjectIdRef.current = buildRun.projectId;
    setFailure(null);
    const task = lastBuildTaskRef.current;
    if (task) {
      void runBuildTurn(prompt, detectBuildIntent(task.originalRequest, { mode: "agent", agentMode: true, projectFileCount: agentFiles.length || (agentProjectId ? 1 : 0) }), crypto.randomUUID(), lastAttachmentsRef.current, false, task, lastBuildVisibleRef.current ?? undefined, { reuseUser: true });
    } else {
      // The same request again: the prompt already in the thread is reused.
      void retry();
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
          // No house palette: the picture takes its colours from the subject,
          // the same rule the Agent follows for the site itself.
          ? `Editorial website hero illustration for: ${subject}. Colours and mood chosen to suit the subject, clean geometric composition, no text, no words, no logos.`
          : `Product feature illustration for: ${subject}. Same palette as the hero image, minimal vector style, no text.`,
    }));
  }

  /**
   * Regenerate: the original prompt is asked again in the SAME conversation
   * with the conversation's current strategy and models. The new answer takes
   * the place of the old one, which is kept as an earlier version — never a
   * second copy of the turn.
   */
  function regenerate() {
    const list = messagesRef.current;
    const replyIndex = lastIndexOfRole(list, "assistant");
    if (replyIndex < 0 || busy) return;
    const prompt = promptFor(list, replyIndex);
    if (!prompt) return;
    const isTail = replyIndex === list.length - 1;
    const saved = Boolean(convIdRef.current);
    void streamMessage(prompt.content, {
      replaceLastAssistant: isTail,
      regenerate: isTail && saved,
      reuseUser: saved,
      attachments: lastAttachmentsRef.current,
      imageStoragePath: lastImagePathRef.current,
    });
  }

  /**
   * Did the last message reach the conversation? After a dropped connection
   * the browser cannot know, so the server is asked before anything is sent
   * twice. If the answer finished while disconnected, it is simply shown.
   */
  async function recoverLastTurn(index: number): Promise<"answered" | "stored" | "unknown"> {
    const id = convIdRef.current;
    const local = messagesRef.current[index];
    if (!id || !local) return "unknown";
    try {
      const page = await rpc<{ hasMore: boolean; messages: ChatMessage[] }>("conversation_messages_page", {
        id, before: new Date(Date.now() + 60_000).toISOString(), limit: 10,
      });
      const stored = page.messages;
      const at = lastIndexOfRole(stored, "user");
      if (at < 0) return "unknown";
      const storedUser = stored[at];
      const same = local.id ? storedUser.id === local.id : storedUser.content === local.content;
      // An earlier message with the same words is not this one.
      const known = !local.id && messagesRef.current.some((item, i) => i !== index && item.id === storedUser.id);
      if (!same || known) return "unknown";
      const replies = stored.slice(at + 1).filter((item) => item.role === "assistant");
      setMessages((current) => {
        if (!current[index]) return current;
        const mine = { ...current[index], id: storedUser.id, metadata: { ...current[index].metadata, send_failed: undefined } };
        return replies.length ? [...current.slice(0, index), mine, ...replies] : [...current.slice(0, index), mine, ...current.slice(index + 1)];
      });
      return replies.length ? "answered" : "stored";
    } catch {
      return "unknown";
    }
  }

  /** Retry a failed response: same conversation, same prompt, no duplicates. */
  async function retry() {
    const list = messagesRef.current;
    const index = lastIndexOfRole(list, "user");
    if (index < 0 || busy || requestInFlightRef.current) return;
    setFailure(null);
    const target = list[index];
    const last = lastTurnRef.current;
    const hasReply = list.slice(index + 1).some((item) => item.role === "assistant");
    let stored = Boolean(target.id) || (last !== null && last.turnId === target.metadata?.turn_id && last.stored);
    if (!stored || !hasReply) {
      const outcome = await recoverLastTurn(index);
      if (outcome === "answered") { setNotice("The answer finished while you were disconnected — here it is."); return; }
      if (outcome === "stored") stored = true;
    }
    const turnId = target.metadata?.turn_id ?? crypto.randomUUID();
    if (!target.metadata?.turn_id) {
      setMessages((current) => current.map((item, i) => (i === index ? { ...item, metadata: { ...item.metadata, turn_id: turnId } } : item)));
    }
    const draft = voiceDraftsRef.current.get(turnId);
    if (!stored && draft?.assetId) {
      // A voice message that never reached the thread: its recording goes with it.
      void send(undefined, target.content, { voice: { turnId, assetId: draft.assetId, attachments: draft.attachments } });
      return;
    }
    const files = last?.turnId === turnId ? lastAttachmentsRef.current : draft?.attachments ?? [];
    void send(undefined, target.content, { resend: { turnId, stored: stored && Boolean(convIdRef.current), replaceReply: hasReply, attachments: files } });
  }

  /**
   * Save an edited user message. For the latest turn this is Edit & resend:
   * the text is corrected in place and asked again, replacing the answer under
   * it. For an older voice message it only corrects the transcript.
   */
  async function submitEdit(key: string, text: string) {
    const list = messagesRef.current;
    const index = list.findIndex((item, i) => messageKey(item, i) === key);
    const target = list[index];
    const next = text.trim();
    if (!target || target.role !== "user" || !next || savingEdit) return;
    const conversationId = convIdRef.current;
    const stored = Boolean(conversationId && target.id);
    if (stored) {
      setSavingEdit(true);
      try {
        await rpc("conversation_message_edit", { conversation_id: conversationId, message_id: target.id, content: next });
      } catch {
        setSavingEdit(false);
        setNotice("The edit could not be saved, so nothing was changed. Try again.");
        return;
      }
      setSavingEdit(false);
    }
    const changed = next !== target.content;
    const turnId = target.metadata?.turn_id ?? crypto.randomUUID();
    const resend = index === lastIndexOfRole(list, "user") && !busy;
    const hasReply = list.slice(index + 1).some((item) => item.role === "assistant");
    setEditingKey(null);
    setMessages((current) => current.map((item, i) => (i === index ? {
      ...item,
      content: next,
      metadata: {
        ...item.metadata,
        turn_id: turnId,
        ...(changed ? { edited_at: new Date().toISOString(), original_content: item.metadata?.original_content ?? item.content } : {}),
      },
    } : item)));
    if (!resend) return;
    const files = lastTurnRef.current?.turnId === turnId ? lastAttachmentsRef.current : voiceDraftsRef.current.get(turnId)?.attachments ?? [];
    await send(undefined, next, { resend: { turnId, stored, replaceReply: hasReply, attachments: files } });
  }

  /** Delete one message — from the conversation's storage, then from the screen. */
  async function confirmDeleteMessage() {
    const targetKey = deleteTarget?.key;
    if (!targetKey || deleting) return;
    const list = messagesRef.current;
    const target = list.find((item, i) => messageKey(item, i) === targetKey);
    if (!target) { setDeleteTarget(null); return; }
    setDeleting(true);
    try {
      if (convIdRef.current && target.id) {
        await rpc("conversation_message_delete", { conversation_id: convIdRef.current, message_id: target.id });
      }
      const turnId = target.role === "user" ? target.metadata?.turn_id : undefined;
      const draft = turnId ? voiceDraftsRef.current.get(turnId) : undefined;
      if (draft && turnId) { URL.revokeObjectURL(draft.clip.url); voiceDraftsRef.current.delete(turnId); }
      if (editingKey === targetKey) setEditingKey(null);
      setMessages((current) => current.filter((item) => item !== target));
      toast("Message deleted");
    } catch {
      setNotice("The message could not be deleted. Try again.");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  async function shareMessage(text: string) {
    const outcome = await shareText(text, title || "QORVYNA");
    if (outcome === "copied") toast("Copied — paste it anywhere to share");
    else if (outcome === "failed") toast("Sharing isn't available in this browser");
  }

  function changeRevealMode(next: RevealMode) {
    setRevealMode(next);
    revealModeRef.current = next;
    void rpc("settings_update", { stream_reveal_mode: next }).catch(() => setNotice("Display preference could not be saved."));
  }

  async function exportConversation() {
    const id = convIdRef.current;
    if (!id) return;
    try {
      const rows = await rpc<{ role: string; content: string; created_at: string }[]>("conversation_messages", { conversation_id: id });
      const url = URL.createObjectURL(new Blob([JSON.stringify({ conversation_id: id, exported_at: new Date().toISOString(), messages: rows }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `qorvyna-chat-${id.slice(0, 8)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setNotice("The conversation could not be exported. Try again.");
    }
  }

  /** Follow-up prompt used by contextual actions (Explain, Sources, …). */
  function askFollowUp(prompt: string) {
    if (streaming) return;
    void send(undefined, prompt);
  }

  /** Add files to the message being written: several at once, each removable. */
  async function handleFiles(files: File[]) {
    if (!files.length) return;
    setFailure(null);
    setComposerError(null);
    const have = new Set(attachments.map((item) => item.name));
    const accepted: PendingAttachment[] = [];
    const problems: string[] = [];
    for (const file of files) {
      if (IMAGE_TYPES.includes(file.type) || file.type.startsWith("image/")) {
        // The models QORVYNA runs read text only; nothing is uploaded.
        problems.push(`${file.name}: images can't be read yet — describe it or paste the text it contains.`);
        continue;
      }
      if (!TEXT_FILE.test(file.name) && !/^(?:Dockerfile|Makefile)$/i.test(file.name)) {
        problems.push(`${file.name}: unsupported type. Attach text, documents or source code.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) { problems.push(`${file.name}: larger than 1 MB.`); continue; }
      if (!have.has(file.name) && have.size >= MAX_ATTACHMENTS) { problems.push(`Up to ${MAX_ATTACHMENTS} files fit in one message.`); break; }
      try {
        accepted.push({ name: file.name, type: file.type, content: await file.text(), size: file.size });
        have.add(file.name);
      } catch {
        problems.push(`${file.name}: could not be read.`);
      }
    }
    if (accepted.length) {
      const names = new Set(accepted.map((file) => file.name));
      setAttachments((current) => [...current.filter((item) => !names.has(item.name)), ...accepted].slice(0, MAX_ATTACHMENTS));
    }
    if (problems.length) setComposerError(Array.from(new Set(problems)).slice(0, 3).join(" "));
  }

  function copyMessage(text: string) {
    void copyText(text).then((ok) => toast(ok ? "Copied to clipboard" : "Copy isn't available in this browser"));
  }

  // -------------------------------------------------------------------------
  // Contextual actions (spec §15/§16) — built per reply, never all at once
  // -------------------------------------------------------------------------

  const actionRegistry = (index: number, message: ChatMessage, signals: ContentSignals, intent: IntentResult, artifact: ArtifactState) => {
    const key = messageKey(message, index);
    const title = firstHeading(message.content, "QORVYNA response");
    const canRun = Boolean(agentFiles.length || agentProjectId);
    const isLatest = index === latestAssistantIndex;
    // A reply that records real execution (a build, a deployment, a pending
    // task) is history, not a draft: it is never regenerated over.
    const executionRecord = Boolean(message.metadata?.build || message.metadata?.deployment || message.metadata?.agent_task);
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
        if (message.metadata?.image_data_url) saveDataUrl(message.metadata.image_data_url, `qorvyna-image-${key.slice(-6)}.png`);
        else if (artifact.format) void downloadBuilt(key, message.content, title, artifact.format);
      },
      editPrompt: () => {
        const prompt = imagePromptRef.current ?? promptFor(messagesRef.current, index)?.content ?? "";
        setInput(prompt);
        textareaRef.current?.focus();
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
    const speaking = speakingId === key || (speakingId === "auto" && isLatest);
    const labels: Record<ResponseActionId, { label: string; icon?: ReactNode }> = {
      copy: { label: "Copy" },
      regenerate: { label: "Regenerate" },
      listen: { label: speaking ? t("chat.stopSpeech") : t("chat.listen"), icon: speaking ? <VolumeX size={14} strokeWidth={1.8} /> : undefined },
      more: { label: "More" },
      copyCode: { label: "Copy code" },
      run: { label: "Run" },
      explain: { label: "Explain" },
      save: { label: "Save" },
      editPrompt: { label: "Edit prompt" },
      sources: { label: "Sources" },
      export: { label: "Export" },
      open: { label: "Open" },
      copyJson: { label: "Copy JSON" },
      activity: { label: "Activity" },
      performance: { label: "Performance" },
      flashcards: { label: "Make flashcards" },
      workspace: { label: "Open workspace" },
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

    // Only the newest answer can be replaced in place, so only it offers Regenerate.
    const offered = (id: ResponseActionId) =>
      id !== "more" && id !== "activity" && id !== "performance" && (id !== "regenerate" || (isLatest && !executionRecord));
    const build = (ids: ResponseActionId[]): ChatAction[] =>
      ids.filter(offered).map((id) => ({
        id: `${key}-${id}`,
        label: labels[id].label,
        icon: labels[id].icon ?? ACTION_ICON[id],
        onClick: handlers[id] ?? (() => {}),
        disabled: id === "regenerate" ? busy : false,
        active: id === "listen" ? speaking : undefined,
      }));

    // Every reply can be shared and deleted — from More, never crowding the row.
    const overflow: ChatAction[] = [
      ...build(plan.overflow),
      { id: `${key}-share`, label: "Share", icon: <Share2 size={14} strokeWidth={1.8} />, onClick: () => void shareMessage(message.content), separated: true },
      { id: `${key}-delete`, label: "Delete message", icon: <Trash2 size={14} strokeWidth={1.8} />, onClick: () => setDeleteTarget({ key, role: "assistant" }), danger: true, disabled: busy },
    ];
    return { primary: build(plan.primary), overflow };
  };

  /** Actions on the user's own message: Copy · Edit · More (Share, Delete). */
  const userActions = (index: number, message: ChatMessage, key: string): { primary: ChatAction[]; overflow: ChatAction[] } => {
    const hasText = Boolean(message.content.trim());
    const primary: ChatAction[] = [
      { id: `${key}-copy`, label: "Copy", icon: <Copy size={14} strokeWidth={1.8} />, onClick: () => copyMessage(message.content), disabled: !hasText },
    ];
    // Edit & resend re-asks the question, so it belongs to the latest turn.
    if (index === latestUserIndex) {
      primary.push({ id: `${key}-edit`, label: "Edit", title: "Edit and resend", icon: <Pencil size={14} strokeWidth={1.8} />, onClick: () => setEditingKey(key), disabled: busy });
    }
    return {
      primary,
      overflow: [
        { id: `${key}-share`, label: "Share", icon: <Share2 size={14} strokeWidth={1.8} />, onClick: () => void shareMessage(message.content), disabled: !hasText },
        { id: `${key}-delete`, label: "Delete message", icon: <Trash2 size={14} strokeWidth={1.8} />, onClick: () => setDeleteTarget({ key, role: "user" }), danger: true, separated: true, disabled: busy },
      ],
    };
  };

  const latestAssistantIndex = useMemo(() => lastIndexOfRole(messages, "assistant"), [messages]);
  const latestUserIndex = useMemo(() => lastIndexOfRole(messages, "user"), [messages]);
  const latestSignals = latestAssistantIndex >= 0 ? signalsByIndex[latestAssistantIndex] : null;
  const imageRun = streaming && runIntent.intent === "IMAGE_GENERATION";

  /** One conversation row. Chat and Agent render every message through this. */
  const renderRow = (message: ChatMessage, index: number): ReactNode => {
    const key = messageKey(message, index);
    // The answer being regenerated steps aside for its replacement.
    if (key === hiddenKey) return null;

    if (message.role === "user") {
      const turn = message.metadata?.turn_id;
      const isVoice = Boolean(message.metadata?.audio_asset_id || message.metadata?.local_audio_url);
      const hasDraft = Boolean(turn && voiceDraftsRef.current.has(turn));
      return (
        <UserMessage
          key={key}
          message={message}
          timeLabel={hydrated ? timeLabelOf(message.created_at) : ""}
          actions={userActions(index, message, key)}
          editing={editingKey === key}
          editMode={index === latestUserIndex ? "resend" : "transcript"}
          saving={savingEdit}
          onSubmitEdit={(text) => void submitEdit(key, text)}
          onCancelEdit={() => setEditingKey(null)}
          onEditTranscript={isVoice ? () => setEditingKey(key) : undefined}
          onRetryVoice={hasDraft && turn ? () => void sendVoiceMessage(turn) : undefined}
          onDiscardVoice={hasDraft && turn ? () => discardVoice(turn) : undefined}
          animate={key !== settledKey}
        />
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
      <div key={key} className={cn(key !== settledKey && "msg-in", "msg-row flex justify-start gap-3")} data-role="assistant">
        <span className="mt-1 hidden shrink-0 sm:block" aria-hidden="true">
          <QorvynaMark compact className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <AssistantMessage
            message={message}
            isLatest={isLatest}
            streaming={busy}
            kind={kind}
            signals={signals}
            intent={intent}
            artifact={artifact}
            execution={isLatest ? execution : null}
            liveBuildRun={isLatest ? buildRun : null}
            onRetryBuild={retryBuild}
            timeLabel={hydrated ? timeLabelOf(message.created_at) : ""}
            actions={actions}
            exportFormats={availableExportFormats(signals, intent.suppressExport ? [] : intent.formats)}
            exportPickerOpen={exportPickerKey === key && !intent.suppressExport}
            onCloseExportPicker={() => setExportPickerKey(null)}
            onPickFormat={(next) => {
              setExportPickerKey(null);
              void buildArtifactFor(key, next, message.content, firstHeading(message.content, "QORVYNA response"));
            }}
            onGenerateArtifact={() => format && void buildArtifactFor(key, format, message.content, firstHeading(message.content, "QORVYNA response"))}
            onDismissArtifact={() => {
              builtRef.current.delete(key);
              setArtifacts((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
            }}
            onOpenArtifact={() => format && void openBuilt(key, message.content, firstHeading(message.content, "QORVYNA response"), format)}
            onSaveArtifact={() => {
              if (message.metadata?.image_data_url) saveDataUrl(message.metadata.image_data_url, `qorvyna-image-${key.slice(-6)}.png`);
              else if (format) void downloadBuilt(key, message.content, firstHeading(message.content, "QORVYNA response"), format);
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
            onRetryInterrupted={isLatest ? regenerate : undefined}
            onCopyVersion={copyMessage}
            onRunWithAgent={isLatest && !isTemporary ? runLatestRequestWithAgent : undefined}
          />
        </div>
      </div>
    );
  };

  // Token frames update only the live reply (lib/stream-store). Settled rows
  // are reused until their own content, actions or metadata change — and the
  // newest reply, the only row that follows build/execution updates, renders
  // on its own so those updates never touch the rest of the conversation.
  const settledRows = useMemo(
    () => messages.map((message, index) => (index === latestAssistantIndex ? null : renderRow(message, index))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, signalsByIndex, artifacts, latestAssistantIndex, latestUserIndex, busy, settledKey, hiddenKey, editingKey, savingEdit,
      exportPickerKey, mode, compact, speakingId, agentFiles, agentProjectId, hydrated, t, router],
  );
  const latestRow = latestAssistantIndex >= 0 ? renderRow(messages[latestAssistantIndex], latestAssistantIndex) : null;
  const renderedHistory = settledRows.map((row, index) => (index === latestAssistantIndex ? latestRow : row));

  const toolbarStatus: ToolbarStatus = recorder.state !== "idle" ? "recording" : busy ? "working" : "idle";
  const emptyConversation = messages.length === 0 && !streaming;
  const conversationActions = convId && !isTemporary ? {
    title: title || "Untitled conversation",
    onRename: async (next: string) => {
      try {
        await rpc("conversation_update", { id: convId, title: next });
        setTitle(next);
        router.refresh();
      } catch {
        setNotice("The conversation could not be renamed. Try again.");
      }
    },
    onExport: () => void exportConversation(),
    onArchive: () => {
      void rpc("conversation_update", { id: convId, archive: true })
        .then(() => { router.push("/chat"); router.refresh(); })
        .catch(() => setNotice("The conversation could not be archived. Try again."));
    },
    onDelete: async () => {
      try {
        await rpc("conversation_update", { id: convId, delete: true });
        router.push("/chat");
        router.refresh();
      } catch {
        setNotice("The conversation could not be deleted. Try again.");
      }
    },
  } : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatTopBar
        mode={mode}
        // "Chat" returns to the chat style that was in use before Agent.
        onModeChange={(next) => switchMode(next === "general" && mode === "agent" ? lastChatStyleRef.current : next)}
        strategy={strategy}
        onStrategyChange={setStrategy}
        revealMode={revealMode}
        onRevealModeChange={changeRevealMode}
        voiceLang={voiceLang}
        onVoiceLangChange={setVoiceLang}
        voiceMode={voiceMode}
        onVoiceModeChange={changeVoiceMode}
        status={toolbarStatus}
        locked={isTemporary}
        autoSpeak={autoSpeak}
        onToggleAutoSpeak={toggleAutoSpeak}
        demoMode={demoMode}
        onToggleDemo={() => setDemoMode((value) => !value)}
        workspaceCount={mode === "agent" ? agentFiles.length : 0}
        onOpenWorkspace={() => setWorkspaceOpen(true)}
        autoSpeakLabels={{ on: t("chat.autoSpeakOn"), off: t("chat.autoSpeakOff") }}
        conversation={conversationActions}
      />

      {!isTemporary ? (
        <JarvisAssistantBar
          speaking={speakingId !== null}
          autoSpeak={autoSpeak}
          voiceLang={voiceLang}
          onVoiceLangChange={setVoiceLang}
          onToggleAutoSpeak={toggleAutoSpeak}
          onInterruptSpeech={() => {
            stopSpeech();
            stopGeneratedSpeech();
            setSpeakingId(null);
          }}
          onStartPushToTalk={() => {
            changeVoiceMode("hands_free");
            void startVoice();
          }}
          onSubmitSpokenCommand={(spoken) => send(undefined, spoken)}
          onJarvisNotice={(msg) => setNotice(msg)}
          onJarvisSettingsChanged={(next) => {
            jarvisSettingsRef.current = next;
          }}
          commandDispatchRef={jarvisDispatchRef}
        />
      ) : null}

      {/* While the conversation is empty the stage is a size container, so the
          welcome screen can fit itself to the room it really has. */}
      <div className={cn("relative min-h-0 flex-1", emptyConversation && "chat-stage")}>
        <div ref={scrollAreaRef} onScroll={chatScroll.onScroll} onWheel={chatScroll.onWheel}
          onTouchStart={chatScroll.onTouchStart} onTouchMove={chatScroll.onTouchMove}
          onKeyDown={chatScroll.onKeyDown} onPointerDown={chatScroll.onPointerDown} onPointerUp={chatScroll.onPointerUp}
          className="chat-viewport h-full overflow-y-auto px-0.5 pb-2 pt-4 sm:px-2" tabIndex={0} aria-label="Conversation">
          <div ref={scrollContentRef} className="mx-auto w-full max-w-3xl space-y-6">
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
            {emptyConversation ? (
              <div className="chat-welcome flex flex-col items-center px-1 py-4 text-center sm:py-8">
                <div className="mb-5">
                  <span className="chat-welcome-mark mb-3 inline-block" aria-hidden="true">
                    <QorvynaMark className="h-14 w-14 sm:h-16 sm:w-16" />
                  </span>
                  <h1 className="text-[22px] font-semibold tracking-tight text-ink sm:text-[28px]">
                    {isTemporary ? "Temporary chat" : mode === "agent" ? "What should we build?" : locale === "bn" ? "আজ কীভাবে সাহায্য করতে পারি?" : "How can I help today?"}
                  </h1>
                  <p className="chat-welcome-sub mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink-2 sm:text-sm">
                    {isTemporary
                      ? "Nothing here enters your history, memory, summaries or search — and it is deleted after 24 hours."
                      : mode === "agent"
                        ? "Describe the product or fix, then attach any existing project files. Review before preview or push."
                        : locale === "bn"
                          ? "লেখা, শেখা, পরিকল্পনা, গবেষণা, কোডিং ও নিরাপদ ডিজিটাল সহায়তা।"
                          : "Ask about writing, learning, planning, research, coding, or safe digital help."}
                  </p>
                </div>
                {mode !== "agent" && !isTemporary ? (
                  <div className="chat-welcome-features mb-5 hidden w-full max-w-2xl grid-cols-2 gap-2 sm:grid lg:grid-cols-4">
                    {FEATURES.map((feature) => (
                      <div key={feature.title} className="rounded-[16px] border border-border bg-surface px-3 py-3 text-left">
                        <span className="text-accent">{feature.icon}</span>
                        <p className="mt-2 text-[13px] font-medium text-ink">{feature.title}</p>
                        <p className="mt-0.5 text-[11px] text-ink-3">{feature.desc}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="chat-welcome-cards grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.label}
                      type="button"
                      onClick={() => {
                        // Agent is a mode of this conversation, not another page.
                        if ("href" in suggestion && suggestion.href) { if (isTemporary) router.push(suggestion.href); else switchMode("agent"); }
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
                  <div className="msg-in msg-row flex justify-start gap-3" data-role="assistant">
                    <span className="mt-1 hidden shrink-0 sm:block" aria-hidden="true">
                      <QorvynaMark compact className="h-5 w-5" />
                    </span>
                    {/* Same box as a committed assistant message, so nothing shifts when the stream completes. */}
                    <div className="min-w-0 flex-1">
                      {imageRun ? (
                        <ArtifactCard
                          state={beginArtifact(requestArtifact(emptyArtifactState(), { type: "IMAGE", title: "QORVYNA image" }))}
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
              </>
            )}

            {sessionInitError ? (
              <ServerProblem
                failure={{
                  ...failureCopy("auth"),
                  title: "Session verification failed",
                  detail: sessionInitError,
                  retryable: true,
                  action: "sign-in",
                }}
                onRetry={() => {
                  setSessionInitError(null);
                  authLifecycle.retry();
                }}
                onDismiss={() => setSessionInitError(null)}
              />
            ) : null}
            {failure ? (
              <ServerProblem failure={failure} onRetry={buildRun?.status === "failed" ? retryBuild : () => void retry()} onDismiss={() => setFailure(null)} />
            ) : null}
            {handoff ? (
              <ExecutionHandoff
                reason={handoff.reason}
                request={handoff.rawMessage}
                busy={streaming}
                onApprove={approveHandoff}
                onAnswerInChat={answerHandoffInChat}
                onDismiss={dismissHandoff}
              />
            ) : null}
            {projectChoices.length ? (
              <div className="rounded-xl border border-border bg-surface p-4" role="group" aria-label="Choose project to edit">
                <p className="mb-2 text-sm font-medium text-ink">Which project should QORVYNA edit?</p>
                <div className="flex flex-wrap gap-2">
                  {projectChoices.map((choice) => (
                    <button key={choice.id} type="button" className="min-h-11 rounded-lg border border-border px-3 text-sm text-ink hover:bg-surface-2"
                      onClick={() => {
                        explicitAgentProjectIdRef.current = choice.id;
                        setAgentProjectId(choice.id);
                        setProjectChoices([]);
                        // The request that was blocked on this choice runs now.
                        const prompt = lastBuildPromptRef.current;
                        const waiting = lastBuildIntentRef.current;
                        if (prompt && waiting && !streaming) {
                          setFailure(null);
                          void runBuildTurn(prompt, waiting, crypto.randomUUID(), lastAttachmentsRef.current, lastBuildWorkspaceOnlyRef.current, lastBuildTaskRef.current, lastBuildVisibleRef.current ?? undefined, { reuseUser: true });
                        } else {
                          setNotice(`Selected ${choice.title}. Write what to change and it will run on this project.`);
                        }
                      }}>
                      {choice.title} · {choice.id.slice(0, 8)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {chatScroll.newBelow ? (
          <button type="button" onClick={chatScroll.follow}
            className="absolute bottom-3 left-1/2 z-10 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 text-xs font-medium text-ink shadow-[var(--shadow-pop)]"
            aria-label="Scroll to new content">New content below <ArrowDown size={13} aria-hidden="true" /></button>
        ) : null}
      </div>

      <div className="shrink-0 pb-2 pt-2 lg:pb-3">
        <div className="mx-auto w-full max-w-3xl">
          {notice ? (
            <p className="mb-2 flex items-start justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink-2" role="status">
              <span className="min-w-0">{notice}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface hover:text-ink">
                <X size={14} aria-hidden="true" />
              </button>
            </p>
          ) : null}
          {composerError ? (
            <p className="mb-2 flex items-start justify-between gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger" role="alert">
              <span className="min-w-0">{composerError}</span>
              <button type="button" onClick={() => setComposerError(null)} aria-label="Dismiss" className="-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-surface">
                <X size={14} aria-hidden="true" />
              </button>
            </p>
          ) : null}
          {dictationRetry ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2" role="alert">
              <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">
                {dictationRetry.message} <span className="text-ink-3">({formatClock(dictationRetry.clip.durationMs / 1000)} recorded)</span>
              </p>
              <button type="button" onClick={() => void transcribeToComposer(dictationRetry.clip)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12.5px] font-medium text-ink hover:bg-surface-2">
                <RotateCcw size={13} aria-hidden="true" /> Try again
              </button>
              <button type="button" onClick={() => { URL.revokeObjectURL(dictationRetry.clip.url); setDictationRetry(null); }} className="min-h-9 rounded-lg px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-danger">
                Discard
              </button>
            </div>
          ) : null}
          <ModeQuickActions
            mode={mode}
            signals={latestSignals}
            hasConversation={latestAssistantIndex >= 0 && !busy}
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
            <p className="mb-2 text-[12.5px] text-ink-2">
              This may fit {modeHint} mode.{" "}
              <button type="button" className="font-semibold text-accent" onClick={() => { const next = modeHint; setModeHint(null); switchMode(next); }}>
                Continue in {modeHint}
              </button>
            </p>
          ) : null}
        </div>

        <ChatComposer
          value={input}
          onChange={(value) => { setInput(value); if (composerError) setComposerError(null); }}
          placeholder={modeMeta(mode).placeholder}
          textareaRef={textareaRef}
          fileInputRef={fileRef}
          sendLabel={t("chat.send")}
          attachments={attachments}
          onRemoveAttachment={(name) => setAttachments((current) => current.filter((item) => item.name !== name))}
          image={pendingImage}
          uploadingImage={uploadingImage}
          onRemoveImage={() => { if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl); setPendingImage(null); }}
          onFiles={(files) => void handleFiles(files)}
          busy={busy}
          onSend={() => void send()}
          onStop={stop}
          recorderState={recorder.state}
          recorderElapsedMs={recorder.elapsedMs}
          recorderHasWaveform={recorder.hasWaveform}
          recorderLiveText={recorder.liveText}
          recorderSpeechDetected={recorder.speechDetected}
          recorderCanvasRef={recorder.canvasRef}
          voiceLanguage={voiceLang}
          onVoiceLanguage={setVoiceLang}
          voiceMode={voiceMode}
          onExitHandsFree={() => changeVoiceMode("dictate")}
          onStartVoice={() => void startVoice()}
          onCancelVoice={cancelVoice}
          onPauseVoice={() => (recorder.state === "paused" ? recorder.resume() : recorder.pause())}
          onStopVoice={() => void finishVoice(voiceModeRef.current === "hands_free" ? "hands_free_send" : "transcribe")}
          onSendAudioClip={() => void finishVoice("send")}
          transcribing={transcribing}
          onCancelTranscribe={() => transcribeAbortRef.current?.abort()}
          webSearch={webSearch}
          onToggleWebSearch={() => setWebSearch((value) => !value)}
          codeFocus={codeHint}
          onToggleCodeFocus={() => setCodeHint((value) => !value)}
        />

        <p className="composer-note mx-auto mt-1.5 hidden max-w-3xl px-1 text-center text-[11px] text-ink-3 sm:block">
          {mode === "agent" ? "Review files before preview or push" : "QORVYNA may make mistakes · verify important information"}
        </p>
      </div>

      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDeleteMessage()}
        title="Delete this message?"
        body={deleteTarget?.role === "assistant"
          ? "This answer is removed from the conversation. This can't be undone."
          : "Your message is removed from the conversation, including its voice recording if it has one. This can't be undone."}
        confirmLabel="Delete"
        busy={deleting}
      />

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
