// =============================================================================
// Chat message model + intent lookup
//
// Shared by the chat surface and the intent-driven UI so that a message, its
// detected intent and its artifact lifecycle travel together (product spec §27).
// =============================================================================

import type { AgentFile, ChatMode } from "@/lib/ai/agent";
import type { ArtifactSnapshot } from "@/lib/ai/artifacts";
import { DEFAULT_INTENT, detectIntent, type ArtifactType, type IntentId, type IntentResult } from "@/lib/ai/intent";

export type MessageMetadata = {
  mode?: ChatMode;
  model?: string;
  coding_detected?: boolean;
  provider?: string;
  fallback?: boolean;
  artifacts?: AgentFile[];
  attachment_names?: string[];
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
};

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  metadata?: MessageMetadata;
};

/** Stable-ish key for per-message UI state (artifacts, export picker). */
export function messageKey(message: ChatMessage, index: number): string {
  const turn = message.metadata?.turn_id;
  if (turn) return `t:${turn}`;
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

export function latestProjectId(list: ChatMessage[]): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const pid = list[i].metadata?.project_id;
    if (typeof pid === "string" && pid) return pid;
  }
  return null;
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
