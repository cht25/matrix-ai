import type { ChatMode } from "@/lib/ai/modes";
import { isChatMode } from "@/lib/ai/modes";
import type { BuildIntent } from "@/lib/ai/build-intent";
import { isCodingRequest, type TextAttachment } from "@/lib/ai/agent";

/** Execution authority is explicit for every request. A stored Agent mode is
 * context, never permission to execute a later unspecified request. */
export function requestChatMode(requested: unknown, temporary = false): ChatMode {
  if (temporary) return "general";
  return isChatMode(requested) && requested !== "image" ? requested : "general";
}

export function mayExecuteAgent(mode: ChatMode, intent: BuildIntent): boolean {
  return (mode === "agent" || mode === "code") && !intent.needsClarification && (intent.build || intent.publish || intent.preview || intent.fix === true);
}

/** In explicit Code mode, implementation requests go to a persisted workspace,
 * while explanations/questions remain normal chat. */
export function shouldCreateCodeWorkspace(input: string, attachments: TextAttachment[] = []): boolean {
  const text = input.trim();
  if (!text) return false;
  if (/^(?:what|why|how|when|where|which|explain|describe|teach|help me understand|can you (?:explain|tell|describe|show me how)|could you (?:explain|show me how)|show me how|tell me how)\b/i.test(text)) return false;
  const action = /\b(?:write|create|build|make|implement|generate|fix|debug|refactor|add|edit|update|scaffold|code|test|need|want)\b/i.test(text);
  const codeObject = /\b(?:code|function|class|script|program|algorithm|component|module|query|api|app|application|website|web ?app|site|bug|software|programming)\b/i.test(text);
  return attachments.length > 0 || (action && (isCodingRequest(text) || codeObject));
}

export function isAgentSourceReply(mode: ChatMode, content: string): boolean {
  return mode === "agent" && (/<<<MATRIX_FILE\b/.test(content) || /^\s*(?:<!doctype html|<html[\s>]|<div[\s>]|<svg[\s>])/im.test(content));
}
