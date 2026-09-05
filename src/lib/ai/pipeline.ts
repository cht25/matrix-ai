export type AgentStageId =
  | "understanding"
  | "planning"
  | "selecting"
  | "executing"
  | "processing"
  | "finalizing";

export type AgentNodeState = "queued" | "running" | "completed" | "failed" | "waiting";

export const AGENT_STAGES: Array<{ id: AgentStageId; label: string; node: string }> = [
  { id: "understanding", label: "Understanding request", node: "Agent Router" },
  { id: "planning", label: "Planning task", node: "Task Planner" },
  { id: "selecting", label: "Selecting tool", node: "Tool Router" },
  { id: "executing", label: "Executing task", node: "Code Runtime" },
  { id: "processing", label: "Processing result", node: "Result Parser" },
  { id: "finalizing", label: "Finalizing response", node: "Final Response" },
];

export type PipelineEvent = {
  at: number;
  type: "stage" | "tool" | "info" | "error" | "complete";
  message: string;
  stage?: AgentStageId;
  tool?: string;
  durationMs?: number;
};

export type PipelineAnalytics = {
  tokensPerSec: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timeToFirstMs: number | null;
  totalLatencyMs: number;
  agentSteps: number;
  toolsExecuted: number;
  successes: number;
  failures: number;
};

export function emptyAnalytics(): PipelineAnalytics {
  return {
    tokensPerSec: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    timeToFirstMs: null,
    totalLatencyMs: 0,
    agentSteps: 0,
    toolsExecuted: 0,
    successes: 0,
    failures: 0,
  };
}

export function computeAnalytics(opts: {
  started: number;
  firstTokenAt?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  agentSteps?: number;
  toolsExecuted?: number;
  failed?: boolean;
}): PipelineAnalytics {
  const totalLatencyMs = Math.max(0, Date.now() - opts.started);
  const inputTokens = opts.promptTokens ?? 0;
  const outputTokens = opts.completionTokens ?? 0;
  const totalTokens = inputTokens + outputTokens;
  const secs = totalLatencyMs / 1000;
  return {
    tokensPerSec: secs > 0 && outputTokens > 0 ? Number((outputTokens / secs).toFixed(1)) : null,
    inputTokens,
    outputTokens,
    totalTokens,
    timeToFirstMs: opts.firstTokenAt ? Math.max(0, opts.firstTokenAt - opts.started) : null,
    totalLatencyMs,
    agentSteps: opts.agentSteps ?? AGENT_STAGES.length,
    toolsExecuted: opts.toolsExecuted ?? 0,
    successes: opts.failed ? 0 : 1,
    failures: opts.failed ? 1 : 0,
  };
}

export function detectAgentTool(message: string): { tool: string; reason: string } {
  const text = message.toLowerCase();
  if (/\b(image|picture|illustration|logo|render|draw)\b/.test(text) && /\b(generat|create|make)\b/.test(text)) {
    return { tool: "image.generate", reason: "Visual generation intent" };
  }
  if (/\b(search|look up|latest|news|web)\b/.test(text)) {
    return { tool: "search.web", reason: "Public knowledge lookup" };
  }
  if (/\b(fix|debug|error|bug|refactor|implement|build|code|website|html|css|react)\b/.test(text)) {
    return { tool: "code.runtime", reason: "Software construction" };
  }
  return { tool: "code.runtime", reason: "Default Agent workspace" };
}
