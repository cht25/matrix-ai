import type { ChatMode } from "@/lib/ai/modes";
import { isChatMode } from "@/lib/ai/modes";
import type { BuildIntent } from "@/lib/ai/build-intent";

/** Execution authority is explicit for every request. A stored Agent mode is
 * context, never permission to execute a later unspecified request. */
export function requestChatMode(requested: unknown, temporary = false): ChatMode {
  if (temporary) return "general";
  return isChatMode(requested) && requested !== "image" ? requested : "general";
}

export function mayExecuteAgent(mode: ChatMode, intent: BuildIntent): boolean {
  return mode === "agent" && !intent.needsClarification && (intent.build || intent.publish || intent.preview || intent.fix === true);
}

export function isAgentSourceReply(mode: ChatMode, content: string): boolean {
  return mode === "agent" && (/<<<MATRIX_FILE\b/.test(content) || /^\s*(?:<!doctype html|<html[\s>]|<div[\s>]|<svg[\s>])/im.test(content));
}
