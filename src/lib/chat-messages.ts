import type { AgentExecutionState, PendingAgentTask } from "@/lib/ai/agent-execution";
// =============================================================================
// Chat message model + intent lookup
//
// Shared by the chat surface and the intent-driven UI so that a message, its
// detected intent and its artifact lifecycle travel together (product spec §27).
// =============================================================================

import type { AgentFile, ChatMode } from "@/lib/ai/agent";
import type { BuildRunSnapshot } from "@/lib/deploy/stages";
import type { ArtifactSnapshot } from "@/lib/ai/artifacts";
import { DEFAULT_INTENT, detectIntent, type ArtifactType, type IntentId, type IntentResult } from "@/lib/ai/intent";

export type WorkingStep = {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "failed";
  at: number;
  durationMs?: number;
};

export type MessageMetadata = {
  mode?: ChatMode;
  agent_task?: PendingAgentTask;
  execution_state?: AgentExecutionState;
  model?: string;
  coding_detected?: boolean;
  provider?: string;
  fallback?: boolean;
  tier?: "high" | "low";
  /** Real server-recorded execution steps (rendered as a compact collapsible pill). */
  steps?: WorkingStep[];
  artifacts?: AgentFile[];
  attachment_names?: string[];
  /** Owner-checked private voice recording associated with this user message. */
  audio_asset_id?: string;
  audio_duration_ms?: number;
  audio_waveform?: number[];
  audio_language?: string | null;
  action?: string;
  project_id?: string;
  image_data_url?: string;
  /** Wall-clock time for the reply. Never rendered as "thinking". */
  duration_ms?: number;
  /** Intent that produced (or was produced for) this message. */
  intent?: IntentId;
  artifact_type?: ArtifactType;
  /** Serializable artifact lifecycle snapshot. */
  artifact?: ArtifactSnapshot;
  /** Stable id tying one request → one reply → its artifact/execution UI. */
  turn_id?: string;
  /**
   * Build pipeline snapshot for this turn (§39). Only present when a real run
   * happened; the live URL inside it comes from the provider, never locally.
   */
  build?: BuildRunSnapshot;
  /** Compact deployment summary for the chat row. */
  deployment?: {
    id: string;
    status: string;
    url: string | null;
    slug: string | null;
    environment: string;
    files: number;
  };
  /**
   * Earlier answers this reply replaced (Regenerate / Edit & resend), oldest
   * first. The message's own `content` is always the current answer.
   */
  versions?: ReplyVersion[];
  /** Set when the user corrected a message after sending it. */
  edited_at?: string;
  original_content?: string;
  edit_count?: number;

  // --- this browser session only (never stored) ----------------------------
  /** Object URL of a recording that has not been (or cannot be) stored. */
  local_audio_url?: string;
  /** A voice message that is still uploading, or that could not be sent. */
  voice_status?: "processing" | "failed";
  voice_error?: string;
  /** The request never reached the conversation; the bubble offers Retry. */
  send_failed?: boolean;
  /** The reply stopped early (Stop, timeout or a dropped connection). */
  interrupted?: boolean;
};

export type ReplyVersion = {
  content: string;
  created_at: string;
  model?: string;
  provider?: string;
  duration_ms?: number;
};

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  metadata?: MessageMetadata;
};

/** Stable key for message UI state. The user and assistant share a turn ID
 * but must NEVER share a React sibling key (or reconciliation remounts them). */
export function messageKey(message: ChatMessage, index: number): string {
  const turn = message.metadata?.turn_id;
  if (turn) return message.role === "user" ? `u:t:${turn}` : `t:${turn}`;
  if (message.id) return `id:${message.id}`;
  return `i:${index}`;
}

export function lastUserContent(list: ChatMessage[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "user") return list[i].content;
  }
  return null;
}

export function latestArtifacts(list: ChatMessage[]): AgentFile[] {
  for (let i = list.length - 1; i >= 0; i--) {
    const files = list[i].metadata?.artifacts;
    if (Array.isArray(files) && files.length) return files;
  }
  return [];
}

/** The most recent build run id, so the chat can re-read its real state. */
export function latestBuildRunId(list: ChatMessage[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const id = list[i].metadata?.build?.run_id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

export function latestProjectId(list: ChatMessage[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const pid = list[i].metadata?.project_id;
    if (typeof pid === "string" && pid) return pid;
  }
  return null;
}

/** Index of the newest message with this role, or -1. */
export function lastIndexOfRole(list: ChatMessage[], role: ChatMessage["role"]): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === role) return i;
  return -1;
}

/** Every answer a reply has had, oldest first; the last entry is the current one. */
export function replyVersions(message: ChatMessage): ReplyVersion[] {
  const earlier = Array.isArray(message.metadata?.versions)
    ? message.metadata!.versions!.filter((version) => version && typeof version.content === "string")
    : [];
  return [
    ...earlier,
    {
      content: message.content,
      created_at: message.created_at ?? "",
      model: message.metadata?.model,
      provider: message.metadata?.provider,
      duration_ms: message.metadata?.duration_ms,
    },
  ];
}

/**
 * Versions to keep on a reply that a regenerated answer is about to replace,
 * mirroring the server (lib/server/chat-messages.ts) so the switcher is right
 * immediately — the server's own list replaces it when the reply is stored.
 */
export function versionsAfterReplace(previous: ChatMessage | undefined, max = 5): ReplyVersion[] {
  if (!previous || previous.role !== "assistant") return [];
  const all = replyVersions(previous).filter((version) => version.content.trim());
  return all.slice(-(max - 1));
}

/** Patch the message that belongs to a turn (by its stable turn id). */
export function patchTurnMessage(
  list: ChatMessage[],
  role: ChatMessage["role"],
  turnId: string,
  patch: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  let changed = false;
  const next = list.map((message) => {
    if (message.role !== role || message.metadata?.turn_id !== turnId) return message;
    changed = true;
    return patch(message);
  });
  return changed ? next : list;
}

/** The user message that prompted the assistant message at `index`. */
export function promptFor(list: ChatMessage[], index: number): ChatMessage | null {
  for (let i = index - 1; i >= 0; i--) {
    if (list[i].role === "user") return list[i];
  }
  return null;
}

/**
 * Intent for an assistant message. Fresh messages carry it in metadata;
 * messages restored from storage are re-classified from the prompt that
 * produced them, so an explicit "make this a PDF" still shows its export
 * affordance after a reload — and nothing else does.
 */
export function intentForMessage(list: ChatMessage[], index: number): IntentResult {
  const message = list[index];
  if (!message) return DEFAULT_INTENT;
  const stored = message.metadata?.intent;
  const prompt = promptFor(list, index);
  const mode = message.metadata?.mode ?? prompt?.metadata?.mode ?? "general";
  if (prompt) {
    const detected = detectIntent(prompt.content, { mode });
    if (stored && stored === detected.intent) return detected;
    if (!stored) return detected;
    // Trust the recorded intent, but keep the detected artifact/format detail.
    return { ...detected, intent: stored };
  }
  if (stored) return { ...DEFAULT_INTENT, intent: stored };
  return DEFAULT_INTENT;
}
