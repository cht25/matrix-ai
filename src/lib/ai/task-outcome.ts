// =============================================================================
// Task outcome — how a piece of Agent work ENDED, in the user's terms.
//
// Every task finishes in exactly one of these states, and the state is derived
// only from what the pipeline recorded (stage results, changed files, the
// hosting provider's answer, the stored error) — never from the model's prose:
//
//   completed          the requested work was carried out and verified
//   failed             the work was attempted and did not succeed
//   blocked            the work cannot proceed until something outside the run
//                      changes: a missing configuration, a permission, a quota,
//                      or a choice only the user can make. The blocker is named.
//   awaiting_approval  real work was requested where it needs the user's
//                      go-ahead first; nothing has run
//
// plus three that are not endings in themselves:
//   awaiting_input (one clarifying question), paused (progress saved, can
//   continue) and cancelled (the user stopped it).
//
// Pure — no React, no network, no storage — and unit tested.
// =============================================================================

import type { BuildRun, BuildRunSnapshot, BuildRunStatus, BuildStageId, StageState } from "@/lib/deploy/stages";

export type TaskOutcomeState =
  | "completed"
  | "failed"
  | "blocked"
  | "awaiting_approval"
  | "awaiting_input"
  | "paused"
  | "cancelled"
  | "running";

export type TaskOutcome = {
  state: TaskOutcomeState;
  /** Short status word shown on the badge. */
  label: string;
  /** One sentence: what happened. */
  summary: string;
  /** Facts taken from the run record that back the state. */
  evidence: string[];
  /** What unblocks or retries the task, when there is something to do. */
  nextStep: string | null;
  code: string | null;
};

export const TASK_OUTCOME_LABELS: Record<TaskOutcomeState, string> = {
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  awaiting_approval: "Awaiting approval",
  awaiting_input: "Needs your answer",
  paused: "Paused",
  cancelled: "Stopped",
  running: "Working",
};

/**
 * Errors that mean "this cannot run until something else changes". Retrying
 * the same request unchanged would hit the same wall, so the wall is named.
 */
const BLOCKERS: Record<string, { summary: string; nextStep: string }> = {
  AI_NOT_CONFIGURED: { summary: "No language model is configured on this deployment.", nextStep: "An administrator must set GROQ_API_KEY on the server, then retry." },
  AI_GATEWAY_NOT_CONFIGURED: { summary: "No language model is configured on this deployment.", nextStep: "An administrator must set GROQ_API_KEY on the server, then retry." },
  CODING_MODEL_NOT_CONFIGURED: { summary: "No language model is configured on this deployment.", nextStep: "An administrator must set GROQ_API_KEY on the server, then retry." },
  HOSTING_NOT_CONFIGURED: { summary: "Publishing is not configured on this deployment.", nextStep: "The files are saved in the project. An administrator must configure hosting before they can be published." },
  PROJECT_CONTEXT_MISSING: { summary: "No project is linked to this conversation.", nextStep: "Choose the project to change, or describe a new one to create." },
  PROJECT_AMBIGUOUS: { summary: "More than one of your projects matches this request.", nextStep: "Choose which project to change." },
  PROJECT_REQUIRED: { summary: "This action needs a project.", nextStep: "Open a project or create one first." },
  PROJECT_NOT_FOUND: { summary: "That project does not exist or is not yours.", nextStep: "Choose one of your own projects." },
  PROJECT_ACCESS_DENIED: { summary: "You do not have access to that project.", nextStep: "Choose one of your own projects." },
  PROJECT_STORAGE_UNAVAILABLE: { summary: "Project storage could not be reached, so nothing was started.", nextStep: "Retry in a moment." },
  TASK_STORAGE_UNAVAILABLE: { summary: "The task record could not be saved, so nothing was started.", nextStep: "Retry in a moment." },
  PUBLISH_RATE_LIMITED: { summary: "The publishing limit for now has been reached.", nextStep: "The files are saved. Publish again later." },
  SLUG_TAKEN: { summary: "That public address is already in use.", nextStep: "Choose a different address and publish again." },
  SLUG_INVALID: { summary: "That public address is not valid.", nextStep: "Choose a different address and publish again." },
  RUNTIME_NOT_SUPPORTED: { summary: "This kind of project cannot be built by the hosted pipeline.", nextStep: "The source files are saved in the project; build it in its own toolchain." },
  CONTINUATION_LIMIT: { summary: "This run has been continued as many times as allowed.", nextStep: "Start the request again; saved files are kept." },
  UNAUTHENTICATED: { summary: "You are signed out.", nextStep: "Sign in again, then retry." },
  DEVICE_SCOPE_DENIED: { summary: "This device session is not allowed to run Agent tasks.", nextStep: "Use a full sign-in session." },
  AGENT_TEMPORARY_CHAT: { summary: "Temporary chats keep nothing, so they cannot own a project.", nextStep: "Start a normal chat to run Agent work." },
};

export function isBlockerCode(code: string | null | undefined): boolean {
  return Boolean(code && BLOCKERS[code]);
}

type OutcomeInput = {
  status: BuildRunStatus | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  deploymentStatus?: string | null;
  url?: string | null;
  previewUrl?: string | null;
  fileCount?: number;
  changed?: number | null;
  workspaceOnly?: boolean;
  stageStates?: Array<[BuildStageId, StageState]>;
  knownIssues?: number;
  continuationMessage?: string | null;
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function stageEvidence(states: Array<[BuildStageId, StageState]> | undefined): string[] {
  if (!states) return [];
  const of = (id: BuildStageId) => states.find(([stage]) => stage === id)?.[1];
  const lines: string[] = [];
  if (of("build") === "completed") lines.push("Build step passed");
  if (of("build") === "failed") lines.push("Build step failed");
  if (of("validate") === "completed") lines.push("Validation passed");
  if (of("validate") === "failed") lines.push("Validation failed");
  return lines;
}

export function resolveOutcome(input: OutcomeInput): TaskOutcome {
  const code = input.errorCode ?? null;
  const make = (state: TaskOutcomeState, summary: string, evidence: string[], nextStep: string | null): TaskOutcome => ({
    state, label: TASK_OUTCOME_LABELS[state], summary, evidence, nextStep, code,
  });
  const evidence: string[] = [];
  if (typeof input.changed === "number" && input.changed > 0) evidence.push(`${plural(input.changed, "file")} changed`);
  else if (input.fileCount) evidence.push(`${plural(input.fileCount, "file")} in the project`);
  evidence.push(...stageEvidence(input.stageStates));
  const live = input.deploymentStatus === "live" && Boolean(input.url);
  if (live) evidence.push(`Published at ${input.url}`);
  else if (input.previewUrl) evidence.push("Preview ready");
  if (input.knownIssues) evidence.push(`${plural(input.knownIssues, "known issue")} reported`);

  switch (input.status) {
    case "succeeded": {
      // The pipeline itself refuses to mark a run succeeded when publishing was
      // requested and no live address came back (stages.ts `succeedRun`), so a
      // succeeded run is taken at its word; "published" is only said when the
      // record carries a live address.
      const summary = live
        ? "The work was built, validated and published."
        : input.workspaceOnly
          ? "The files were written to the project workspace. Build checks and publishing were not requested."
          : "The work was built and validated.";
      return make("completed", summary, evidence, null);
    }
    case "awaiting_input":
      return make("awaiting_input", "One detail is needed before the work can start.", [], "Answer the question in the chat.");
    case "paused":
      return make("paused", input.continuationMessage ?? "The run stopped with its progress saved.", evidence, "Continue the run to pick up where it stopped.");
    case "cancelled":
      return make("cancelled", "You stopped this run. Files already saved stay in the project.", evidence, null);
    case "requested":
    case "running":
      return make("running", "The work is in progress.", evidence, null);
    case "failed":
    default: {
      const blocker = code ? BLOCKERS[code] : undefined;
      // The recorded message is the specific reason; the table is the fallback.
      if (blocker) return make("blocked", (input.errorMessage ?? "").trim() || blocker.summary, evidence, blocker.nextStep);
      const summary = (input.errorMessage ?? "").trim() || "The run stopped before it finished.";
      return make("failed", summary, evidence, "Retry the request. Files already saved stay in the project.");
    }
  }
}

/** Outcome of a live run. */
export function outcomeOfRun(run: BuildRun): TaskOutcome {
  return resolveOutcome({
    status: run.status,
    errorCode: run.error?.code,
    errorMessage: run.error?.message,
    deploymentStatus: run.deployment?.status ?? null,
    url: run.deployment?.url ?? null,
    previewUrl: run.previewUrl,
    fileCount: run.fileCount,
    changed: run.changes.length,
    workspaceOnly: run.workspaceOnly === true,
    stageStates: run.stages.map((stage) => [stage.id, stage.state]),
    knownIssues: run.knownIssues,
    continuationMessage: run.continuation?.message ?? null,
  });
}

/** Outcome of a run restored from chat history. */
export function outcomeOfSnapshot(snapshot: Partial<BuildRunSnapshot>): TaskOutcome {
  return resolveOutcome({
    status: snapshot.status ?? null,
    errorCode: snapshot.error_code,
    deploymentStatus: snapshot.deployment_status ?? null,
    url: snapshot.url ?? null,
    previewUrl: snapshot.preview_url ?? null,
    fileCount: snapshot.file_count,
    workspaceOnly: snapshot.workspace_only === true,
    stageStates: snapshot.stage_states,
  });
}

/** A request the browser could not even start (network, HTTP error). */
export function outcomeOfRequestError(code: string, message: string): TaskOutcome {
  return resolveOutcome({ status: "failed", errorCode: code || null, errorMessage: message });
}

/** Real work asked for in a conversation mode: nothing has run. */
export function awaitingApprovalOutcome(detail: string): TaskOutcome {
  return { state: "awaiting_approval", label: TASK_OUTCOME_LABELS.awaiting_approval, summary: detail, evidence: [], nextStep: "Approve to start the Agent, or ask for a chat answer instead.", code: null };
}
