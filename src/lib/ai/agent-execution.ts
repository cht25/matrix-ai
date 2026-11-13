import { parseAgentResponse, safeAgentPath, type AgentFile } from "@/lib/ai/agent";

/** Task state is not inferred from the original prompt once work is underway. */
export type AgentExecutionState = "CONVERSATION" | "CLARIFICATION_REQUIRED" | "PLANNING" | "FILE_GENERATION" | "VALIDATION" | "BUILD" | "DEPLOYMENT" | "COMPLETED" | "FAILED";
export type PendingAgentTask = {
  originalRequest: string;
  clarifications: Array<{ question: string; answer: string }>;
  state: AgentExecutionState;
  projectId?: string | null;
  taskId?: string | null;
};

export function requestsClarificationFirst(prompt: string): boolean {
  return /\b(?:start|begin|first|before\s+(?:building|coding|generating))\b.{0,90}\b(?:ask|clarif|question|missing\s+requirement)\b|\b(?:ask|clarif)\b.{0,90}\b(?:first|before\s+(?:building|coding|generating))\b/i.test(prompt);
}

/** Classify the provider's actual output. A request to build is never evidence
 * that the provider generated files. Reject unknown structured operations. */
export function classifyAgentOutput(raw: string, toolCalls: Array<{ function: { name: string; arguments: string } }> = []):
  { state: AgentExecutionState; reply: string; files: AgentFile[] } {
  const parsed = parseAgentResponse(raw, { allowUnlabelledFences: false, allowRawHtmlDocument: true });
  const files = [...parsed.files];
  let structuredReply = "";
  // Some providers emit JSON file operations rather than the text protocol.
  // Accept only bounded full-file writes; no shell commands or deletes.
  try {
    const json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { reply?: unknown; summary?: unknown; files?: Array<{ path?: unknown; content?: unknown }>; operations?: Array<{ path?: unknown; content?: unknown; type?: string }> };
    structuredReply = typeof json.reply === "string" ? json.reply : typeof json.summary === "string" ? json.summary : "";
    for (const entry of [...(Array.isArray(json.files) ? json.files : []), ...(Array.isArray(json.operations) ? json.operations.filter((op) => /^(?:write|create|update)$/.test(op.type ?? "")) : [])].slice(0, 80)) {
      const path = typeof entry.path === "string" ? safeAgentPath(entry.path) : null;
      if (path && typeof entry.content === "string" && entry.content.length <= 200_000 && !files.some((file) => file.path === path)) files.push({ path, content: entry.content, language: path.split(".").pop() ?? "text" });
    }
  } catch { /* ordinary text or Markdown */ }
  for (const call of toolCalls.slice(0, 80)) {
    if (!/^(?:write_file|create_file|update_file|file_write)$/.test(call.function.name)) continue;
    try {
      const args = JSON.parse(call.function.arguments) as { path?: unknown; content?: unknown };
      const path = typeof args.path === "string" ? safeAgentPath(args.path) : null;
      if (path && typeof args.content === "string" && args.content.length <= 200_000 && !files.some((file) => file.path === path)) {
        files.push({ path, content: args.content, language: path.split(".").pop() ?? "text" });
      }
    } catch { /* malformed tool arguments are never executed */ }
  }
  if (files.length) return { state: "FILE_GENERATION", reply: structuredReply || (raw.trim().startsWith("{") ? "" : parsed.reply), files };
  const text = parsed.reply.trim();
  if (!text) return { state: "FAILED", reply: "", files: [] };
  // Only a user-facing request for information (not a rhetorical question in a
  // plan or a question inside code) can pause a build. Empty file output with
  // an explanatory sentence remains a genuine generation failure.
  const sentences = text.replace(/\*\*/g, "").split(/(?<=[?.!])\s+/);
  const question = sentences.find((part) => /\?\s*$/.test(part.trim()) && /^(?:what|which|who|where|when|how|do|does|is|are|can|could|would|should|please|before\s+i\s+(?:start|build)|to\s+begin)/i.test(part.trim()));
  if (question && text.length < 1100 && !/```|<<<MATRIX_FILE/.test(raw)) return { state: "CLARIFICATION_REQUIRED", reply: text, files: [] };
  if (/\b(?:plan|approach|steps|propose|first,?\s+i\s+will)\b/i.test(text)) return { state: "PLANNING", reply: text, files: [] };
  return { state: "CONVERSATION", reply: text, files: [] };
}

export function pendingTaskFromMessages(messages: Array<{ role: string; metadata?: { agent_task?: PendingAgentTask } }>): PendingAgentTask | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const task = messages[i].metadata?.agent_task;
    if (messages[i].role !== "assistant" || !task) continue;
    return task.state === "CLARIFICATION_REQUIRED" ? task : null;
  }
  return null;
}

export function resumedTaskPrompt(task: PendingAgentTask, answer: string): string {
  const instruction = task.originalRequest.replace(/(?:start|begin)\s+by\s+asking[^.!?]*[.!?]?/gi, "").trim();
  return [instruction, ...task.clarifications.map(({ question, answer: prior }) => `Clarification: ${question}\nAnswer: ${prior}`), "Implement using these requirements. Do not ask again for information the user already supplied."].join("\n\n");
}

export function cancelsPendingTask(text: string): boolean {
  return /^(?:cancel|stop|never\s*mind|forget\s*(?:it|this)|abort)(?:\s+(?:the\s+)?(?:task|build|project|website))?[.!\s]*$/i.test(text.trim());
}

export function isTaskInterruption(text: string): boolean {
  return /^(?:hi|hello|hey|what|why|how|when|where|can you|could you|explain|forget that|instead,?\s+(?:build|create|make))\b/i.test(text.trim());
}

export function isClarificationAnswer(text: string): boolean {
  return Boolean(text.trim()) && !cancelsPendingTask(text) && !isTaskInterruption(text) && !/\b(?:ask\s+(?:me\s+)?(?:another|more)|before\s+you\s+build|not\s+yet)\b/i.test(text) && !/^(?:i\s+don'?t\s+know|not\s+sure|you\s+decide|what\s+do\s+you\s+think|\?)\s*[.!?]*$/i.test(text.trim());
}

/** Only real stage events advance execution; a conversational answer cannot
 * become file generation or completion by virtue of its original intent. */
export type AgentExecutionEvent = "ask" | "plan" | "files_saved" | "validation_started" | "build_started" | "deployment_started" | "complete" | "error" | "cancel";
export function transitionAgentExecution(state: AgentExecutionState, event: AgentExecutionEvent): AgentExecutionState {
  if (event === "error") return "FAILED";
  if (event === "cancel") return "CONVERSATION";
  if (event === "ask") return "CLARIFICATION_REQUIRED";
  if (event === "plan") return "PLANNING";
  if (event === "files_saved") return "FILE_GENERATION";
  if (event === "validation_started" && (state === "FILE_GENERATION" || state === "BUILD")) return "VALIDATION";
  if (event === "build_started" && (state === "VALIDATION" || state === "FILE_GENERATION")) return "BUILD";
  if (event === "deployment_started" && (state === "BUILD" || state === "VALIDATION")) return "DEPLOYMENT";
  if (event === "complete" && (state === "BUILD" || state === "VALIDATION" || state === "DEPLOYMENT")) return "COMPLETED";
  return state;
}
