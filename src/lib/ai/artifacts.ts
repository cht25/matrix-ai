// =============================================================================
// MATRIX artifact + execution state
//
// Artifacts follow a strict lifecycle (product spec §18):
//
//   Not Requested → Requested → Generating → Ready → Available
//
// An artifact never exists in the UI before the user asks for it, and the
// transition functions below refuse to skip a step — so "Ready" can never be
// rendered for something that was never requested.
//
// Execution state models the high-level activity feed (§12). It only ever
// exposes whitelisted, safe status lines — never a model's private reasoning.
//
// Pure module: no React, no DOM, no network — fully unit tested.
// =============================================================================

import { AGENT_STAGES, type AgentStageId, type PipelineAnalytics, type PipelineEvent } from "@/lib/ai/pipeline";
import { artifactToFormat, formatToArtifact, type ArtifactType, type ExportFormat } from "@/lib/ai/intent";
import { extractJson, extractTableRows } from "@/lib/export/response-export";

export type ArtifactStatus = "requested" | "generating" | "ready" | "failed";

export type ArtifactState = {
  /** False until the user asks for something. */
  requested: boolean;
  /** "NONE" when nothing was requested. */
  type: ArtifactType;
  status: ArtifactStatus | null;
  format: ExportFormat | null;
  /** Human label, e.g. "PDF". */
  label: string;
  /** Document title used by the exporters. */
  title: string;
  filename: string | null;
  error: string | null;
  requestedAt: number | null;
  readyAt: number | null;
  durationMs: number | null;
};

export function emptyArtifactState(): ArtifactState {
  return {
    requested: false,
    type: "NONE",
    status: null,
    format: null,
    label: "",
    title: "MATRIX response",
    filename: null,
    error: null,
    requestedAt: null,
    readyAt: null,
    durationMs: null,
  };
}

/** True when the UI is allowed to render an artifact surface at all. */
export function isArtifactVisible(state: ArtifactState): boolean {
  return state.requested && state.type !== "NONE" && state.status !== null;
}

export function isArtifactReady(state: ArtifactState): boolean {
  return state.status === "ready";
}

/** Artifact labels used across the UI. */
export function artifactLabel(type: ArtifactType): string {
  switch (type) {
    case "PDF": return "PDF";
    case "DOCX": return "DOCX";
    case "CSV": return "CSV";
    case "XLSX": return "Excel";
    case "JSON": return "JSON";
    case "TXT": return "TXT";
    case "MARKDOWN": return "Markdown";
    case "CODE": return "Code";
    case "IMAGE": return "Image";
    case "RESEARCH": return "Research";
    case "AGENT_TASK": return "Agent task";
    default: return "";
  }
}

export function artifactFilename(type: ArtifactType, title: string): string | null {
  const format = artifactToFormat(type);
  if (!format) {
    // Non-document artifacts still need a sensible download name.
    if (type === "IMAGE") return "matrix-image.png";
    return null;
  }
  const base = slugify(title) || "matrix-response";
  const ext = format === "markdown" ? "md" : format === "docx" ? "docx" : format;
  return `${base}.${ext}`;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export type ArtifactRequest = {
  type?: ArtifactType;
  format?: ExportFormat;
  title?: string;
};

/**
 * Not Requested → Requested. Ignored when something is already in flight.
 */
export function requestArtifact(state: ArtifactState, request: ArtifactRequest): ArtifactState {
  const format = request.format ?? (request.type ? artifactToFormat(request.type) : null);
  const type = request.type ?? (format ? formatToArtifact(format) : "NONE");
  // Non-document artifacts (IMAGE, AGENT_TASK) have no export format but are
  // still real lifecycle subjects.
  if (type === "NONE") return state;
  if (state.requested && state.status !== "failed") return state;
  const title = (request.title ?? "MATRIX response").trim() || "MATRIX response";
  return {
    ...emptyArtifactState(),
    requested: true,
    type,
    status: "requested",
    format,
    label: artifactLabel(type),
    title,
    filename: artifactFilename(type, title),
    requestedAt: Date.now(),
  };
}

/** Requested → Generating. */
export function beginArtifact(state: ArtifactState): ArtifactState {
  if (!state.requested || state.status !== "requested") return state;
  return { ...state, status: "generating", error: null };
}

/** Generating → Ready. */
export function completeArtifact(state: ArtifactState, filename?: string): ArtifactState {
  if (state.status !== "generating") return state;
  const readyAt = Date.now();
  return {
    ...state,
    status: "ready",
    filename: filename ?? state.filename,
    readyAt,
    durationMs: state.requestedAt ? readyAt - state.requestedAt : null,
    error: null,
  };
}

/** Any in-flight state → Failed (retryable through `requestArtifact`). */
export function failArtifact(state: ArtifactState, error: string): ArtifactState {
  if (!state.requested || state.status === "ready") return state;
  return { ...state, status: "failed", error };
}

/** Back to Not Requested. */
export function clearArtifact(): ArtifactState {
  return emptyArtifactState();
}

/** Copy for the artifact card, per lifecycle step. */
export function artifactStatusCopy(state: ArtifactState): { title: string; detail: string | null; tone: "idle" | "active" | "success" | "danger" } | null {
  if (!isArtifactVisible(state)) return null;
  switch (state.status) {
    case "requested":
      return { title: `${state.label} requested`, detail: null, tone: "idle" };
    case "generating":
      return { title: `Generating ${state.label}…`, detail: null, tone: "active" };
    case "ready":
      return {
        title: `${state.label} ready`,
        detail: state.durationMs != null ? `Built in ${(state.durationMs / 1000).toFixed(2)}s` : null,
        tone: "success",
      };
    case "failed":
      return { title: `${state.label} failed`, detail: state.error ?? "Try again.", tone: "danger" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Execution state — high-level activity only
// ---------------------------------------------------------------------------

export type ExecutionStatus = "idle" | "running" | "complete" | "failed";

export type ExecutionState = {
  status: ExecutionStatus;
  stage: AgentStageId | "complete" | null;
  tool: string | null;
  events: PipelineEvent[];
  analytics: PipelineAnalytics | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export function emptyExecution(): ExecutionState {
  return {
    status: "idle",
    stage: null,
    tool: null,
    events: [],
    analytics: null,
    startedAt: null,
    finishedAt: null,
  };
}

export function hasExecutionDetail(state: ExecutionState): boolean {
  return state.status !== "idle" || state.events.length > 0 || state.analytics !== null;
}

export function startExecution(state: ExecutionState, firstLine?: string): ExecutionState {
  return {
    ...emptyExecution(),
    status: "running",
    startedAt: Date.now(),
    events: firstLine ? [{ at: Date.now(), type: "info", message: firstLine }] : [],
  };
}

export function advanceExecution(
  state: ExecutionState,
  patch: Partial<Pick<ExecutionState, "stage" | "tool" | "analytics">> & { event?: PipelineEvent },
): ExecutionState {
  return {
    ...state,
    stage: patch.stage ?? state.stage,
    tool: patch.tool ?? state.tool,
    analytics: patch.analytics ?? state.analytics,
    events: patch.event ? [...state.events, patch.event].slice(-80) : state.events,
  };
}

export function finishExecution(state: ExecutionState, status: "complete" | "failed" = "complete"): ExecutionState {
  if (state.status === "idle") return state;
  return { ...state, status, stage: status === "complete" ? "complete" : state.stage, finishedAt: Date.now() };
}

/**
 * Safe, whitelisted activity lines. The raw event stream can carry provider
 * text; only known high-level statuses are ever shown to the user, so private
 * chain-of-thought can never leak into the UI.
 */
const STAGE_LABELS = new Map<string, string>([
  ...AGENT_STAGES.map((stage) => [stage.id, stage.node] as [string, string]),
  ["complete", "Response delivered"],
]);

const SAFE_INFO = new Set([
  "connecting",
  "agent initialized",
  "image generation started",
  "response ready",
  "request accepted",
  "capability selected",
]);

export type ActivityLine = { at: number; label: string; state: "done" | "active" | "failed" };

export function activityLines(state: ExecutionState): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const event of state.events) {
    const message = (event.message ?? "").trim();
    if (event.type === "stage") {
      const label = STAGE_LABELS.get(String(event.stage ?? "")) ?? "Processing request";
      lines.push({ at: event.at, label, state: state.status === "running" && event.stage === state.stage ? "active" : "done" });
      continue;
    }
    if (event.type === "tool") {
      lines.push({ at: event.at, label: event.tool ? `Executing tool · ${safeTool(event.tool)}` : "Executing tool", state: "done" });
      continue;
    }
    if (event.type === "error") {
      lines.push({ at: event.at, label: "Something went wrong", state: "failed" });
      continue;
    }
    if (event.type === "complete") {
      lines.push({ at: event.at, label: "Response ready", state: "done" });
      continue;
    }
    // info: only whitelisted copy passes through.
    if (SAFE_INFO.has(message.toLowerCase())) {
      lines.push({ at: event.at, label: titleCase(message), state: "done" });
    } else {
      lines.push({ at: event.at, label: "Processing request", state: "done" });
    }
  }
  if (state.status === "running" && (lines.length === 0 || lines[lines.length - 1].state !== "active")) {
    lines.push({ at: Date.now(), label: "Preparing response", state: "active" });
  }
  return dedupeAdjacent(lines);
}

function dedupeAdjacent(lines: ActivityLine[]): ActivityLine[] {
  return lines.filter((line, index) => index === 0 || lines[index - 1].label !== line.label);
}

const TOOL_PATTERN = /^[a-z0-9._-]{1,48}$/i;

/** Tool identifiers are internal strings — never render anything unexpected. */
function safeTool(tool: string): string {
  return TOOL_PATTERN.test(tool) ? tool : "tool";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Minimal serializable snapshot stored on a message (Firestore-safe). */
export type ArtifactSnapshot = {
  requested: boolean;
  type: ArtifactType;
  status: ArtifactStatus | null;
  format: ExportFormat | null;
  filename: string | null;
  title: string;
};

export function toSnapshot(state: ArtifactState): ArtifactSnapshot | null {
  if (!isArtifactVisible(state)) return null;
  return {
    requested: state.requested,
    type: state.type,
    status: state.status,
    format: state.format,
    filename: state.filename,
    title: state.title,
  };
}

export function fromSnapshot(snapshot: ArtifactSnapshot | null | undefined): ArtifactState {
  if (!snapshot || !snapshot.requested || snapshot.type === "NONE") return emptyArtifactState();
  return {
    ...emptyArtifactState(),
    requested: true,
    type: snapshot.type,
    status: snapshot.status ?? "requested",
    format: snapshot.format ?? artifactToFormat(snapshot.type),
    label: artifactLabel(snapshot.type),
    title: snapshot.title || "MATRIX response",
    filename: snapshot.filename ?? artifactFilename(snapshot.type, snapshot.title || "MATRIX response"),
  };
}

// ---------------------------------------------------------------------------
// Which content an export request refers to
// ---------------------------------------------------------------------------

/** "Sure — here is your PDF." is an acknowledgement, not the document. */
const ACKNOWLEDGEMENT = /^(?:sure|ok(?:ay)?|certainly|done|here|your|i(?:'ve| have|'ll| will)|let me|absolutely|of course|great|no problem)\b/i;

function isAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (/^(?:#{1,6}\s|[-*•]\s|```|\|)/m.test(trimmed)) return false;
  return ACKNOWLEDGEMENT.test(trimmed);
}

/**
 * Resolve what an export request should actually contain.
 *
 * "Turn this answer into a PDF" refers to the PREVIOUS answer, while "Create a
 * CSV from this table" refers to the table in the reply that just arrived. The
 * rule is content-driven: for tabular/JSON formats we take whichever message
 * really holds that data; for documents we fall back to the previous answer
 * only when the new reply is a short acknowledgement.
 */
export function pickArtifactContent(options: {
  format: ExportFormat;
  reply: string;
  previous?: string | null;
}): string {
  const { format, reply, previous } = options;
  const prev = previous?.trim() ? previous : null;

  if (format === "csv" || format === "xlsx") {
    if (extractTableRows(reply)) return reply;
    if (prev && extractTableRows(prev)) return prev;
    return reply;
  }
  if (format === "json") {
    if (extractJson(reply)) return reply;
    if (prev && extractJson(prev)) return prev;
    return reply;
  }
  if (prev && isAcknowledgement(reply) && prev.length > reply.length) return prev;
  return reply;
}
