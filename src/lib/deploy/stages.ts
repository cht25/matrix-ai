// =============================================================================
// MATRIX build pipeline model
//
//   USER REQUEST → INTENT → PLAN → GENERATE FILES → BUILD → VALIDATE
//     → PUBLISH → DEPLOYMENT RESULT
//
// This module owns the *shape* of a build run and the only legal way its state
// may change. It is pure so the rules can be unit tested:
//
//   • A stage never becomes "completed" without a real completion event.
//   • A run never becomes "succeeded" while publishing was requested but no
//     provider returned a live deployment with a URL.
//   • A run that stops reporting is failed by `applyStaleness`, so
//     "Publishing..." can never sit on screen forever (§4).
//
// Stage ids double as the persisted contract between /api/build and the UI.
// =============================================================================

import type { BuildCheck } from "@/lib/deploy/validate";
import { normalizeStatus, type DeploymentStatus } from "@/lib/deploy/status";

export type BuildStageId = "plan" | "generate" | "install" | "build" | "validate" | "publish";

export type BuildStageDef = {
  id: BuildStageId;
  /** Copy shown in the live build status component. */
  label: string;
  detail: string;
  /** How long this stage may stay silent before the run is declared failed. */
  timeoutMs: number;
};

export const BUILD_STAGES: BuildStageDef[] = [
  { id: "plan", label: "Planning", detail: "Project, entry page and public address", timeoutMs: 45_000 },
  { id: "generate", label: "Generating files", detail: "Agent writes the project files", timeoutMs: 240_000 },
  { id: "install", label: "Checking dependencies", detail: "Static hosting does not run npm install", timeoutMs: 60_000 },
  { id: "build", label: "Building", detail: "Bundle and inline project assets", timeoutMs: 120_000 },
  { id: "validate", label: "Validating", detail: "Syntax, routes, assets and build checks", timeoutMs: 60_000 },
  { id: "publish", label: "Publishing", detail: "Upload to MATRIX hosting", timeoutMs: 120_000 },
];

export const BUILD_STAGE_IDS = BUILD_STAGES.map((stage) => stage.id);

export function stageDef(id: BuildStageId): BuildStageDef {
  return BUILD_STAGES.find((stage) => stage.id === id) ?? BUILD_STAGES[0];
}

export type StageState = "queued" | "running" | "completed" | "failed" | "skipped";

export type BuildStage = {
  id: BuildStageId;
  state: StageState;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
};

export type FileChangeKind = "created" | "modified" | "removed";

export type FileChange = { path: string; kind: FileChangeKind };

export type BuildLogLine = {
  at: number;
  stage: BuildStageId | null;
  level: "info" | "warn" | "error" | "success";
  message: string;
};

export type BuildRunStatus = "requested" | "running" | "succeeded" | "failed" | "cancelled" | "awaiting_input" | "paused";

/** Why a run stopped with its progress saved, and where it picks up again. */
export type RunContinuation = {
  available: boolean;
  reason: "time_limit" | "provider_unavailable" | "interrupted";
  phase: "generate" | "repair" | "publish";
  /** Epoch ms before which resuming is pointless (provider cool-down), or null. */
  retryAt: number | null;
  message: string;
};

/** One repair step, as measured by re-validating the project. */
export type RunRepair = {
  attempt: number;
  kind: "deterministic" | "model";
  outcome: "accepted" | "partly_accepted" | "rejected" | "no_change" | "provider_error";
  errorsBefore: number;
  errorsAfter: number;
  files: string[];
  detail: string;
};

export type BuildEnvironment = "preview" | "production";

/** What the hosting provider actually returned. Never synthesised locally. */
export type DeploymentRef = {
  id: string;
  status: DeploymentStatus;
  url: string | null;
  slug: string | null;
  environment: BuildEnvironment;
  rollbackAvailable: boolean;
  /** True when the user explicitly published despite a failing build. */
  overridden: boolean;
  error: string | null;
};

export type BuildActions = {
  /** Create/refresh project files with the Agent. */
  build: boolean;
  /** Publish through the deployment provider. */
  publish: boolean;
  /** Start the in-app preview environment. */
  preview: boolean;
  /** Repair an existing project (the Agent is still the one writing files). */
  fix?: boolean;
};

/** The model that produced the run. Always the single MATRIX model. */
export type RunModelInfo = {
  provider: string;
  model: string;
};

export type RunDesignInfo = {
  direction: string;
  mode: "light" | "dark";
  primary: string;
  background: string;
  heading: string;
  source: "heuristic" | "model-refined";
  /** For edits: which aspects of the design this run set out to change. */
  changed?: string[];
};

export type BuildRun = {
  id: string;
  projectId: string | null;
  projectTitle?: string | null;
  conversationId: string | null;
  requestId: string | null;
  taskId: string | null;
  cancelRequested: boolean;
  status: BuildRunStatus;
  actions: BuildActions;
  /** True when source files were saved without executing build/preview checks. */
  workspaceOnly?: boolean;
  environment: BuildEnvironment;
  stages: BuildStage[];
  changes: FileChange[];
  validation: BuildCheck[] | null;
  /** Auto-fix attempts used so far (§15). */
  attempts: number;
  maxAttempts: number;
  fileCount: number;
  deployment: DeploymentRef | null;
  /** Same-origin path of the in-app sandboxed preview, when one is ready. */
  previewUrl: string | null;
  /** The model that ACTUALLY produced the files, and every route that failed first. */
  model?: RunModelInfo | null;
  /** Summary of the design specification the files were generated from. */
  design?: RunDesignInfo | null;
  error: { code: string; message: string } | null;
  /** Set when the run stopped with saved progress and can continue. */
  continuation?: RunContinuation | null;
  /** Execution sessions used so far for this one run (1 = never continued). */
  segment?: number;
  /** What the repair loop did, step by step. */
  repairs?: RunRepair[];
  /** Problems published with the site and reported to the user. */
  knownIssues?: number;
  logs: BuildLogLine[];
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

export const MAX_RUN_SEGMENTS = 6;

export const MAX_LOG_LINES = 240;

export function initialStages(): BuildStage[] {
  return BUILD_STAGES.map((stage) => ({
    id: stage.id,
    state: "queued" as StageState,
    message: "",
    startedAt: null,
    finishedAt: null,
  }));
}

export function createBuildRun(input: {
  id: string;
  projectId?: string | null;
  projectTitle?: string | null;
  conversationId?: string | null;
  requestId?: string | null;
  taskId?: string | null;
  actions: BuildActions;
  workspaceOnly?: boolean;
  environment?: BuildEnvironment;
  maxAttempts?: number;
  now: number;
}): BuildRun {
  return {
    id: input.id,
    projectId: input.projectId ?? null,
    projectTitle: input.projectTitle ?? null,
    conversationId: input.conversationId ?? null,
    requestId: input.requestId ?? null,
    taskId: input.taskId ?? null,
    cancelRequested: false,
    status: "requested",
    actions: input.actions,
    workspaceOnly: input.workspaceOnly === true,
    environment: input.environment ?? "production",
    stages: initialStages(),
    changes: [],
    validation: null,
    attempts: 0,
    maxAttempts: Math.max(0, Math.min(8, input.maxAttempts ?? 4)),
    fileCount: 0,
    deployment: null,
    previewUrl: null,
    error: null,
    logs: [],
    startedAt: input.now,
    updatedAt: input.now,
    finishedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function replaceStage(run: BuildRun, id: BuildStageId, patch: Partial<BuildStage>): BuildRun {
  return {
    ...run,
    status: run.status === "requested" ? "running" : run.status,
    updatedAt: run.updatedAt,
    stages: run.stages.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage)),
  };
}

export function log(run: BuildRun, entry: Omit<BuildLogLine, "at"> & { at?: number }): BuildRun {
  const line: BuildLogLine = { at: entry.at ?? run.updatedAt, stage: entry.stage, level: entry.level, message: entry.message };
  return { ...run, logs: [...run.logs, line].slice(-MAX_LOG_LINES) };
}

/** Mark a stage as actually running. Only legal while queued or running. */
export function beginStage(run: BuildRun, id: BuildStageId, now: number, message?: string): BuildRun {
  const current = run.stages.find((stage) => stage.id === id);
  if (!current || (current.state !== "queued" && current.state !== "running")) return run;
  const next = replaceStage(run, id, { state: "running", message: message ?? current.message, startedAt: current.startedAt ?? now });
  return { ...next, updatedAt: now };
}

/**
 * Complete a stage. A stage can only be completed while it is running — the
 * pipeline therefore cannot quietly report work it never did.
 */
export function completeStage(run: BuildRun, id: BuildStageId, now: number, message?: string): BuildRun {
  const current = run.stages.find((stage) => stage.id === id);
  if (!current || (current.state !== "running" && current.state !== "queued")) return run;
  const next = replaceStage(run, id, {
    state: "completed",
    message: message ?? current.message,
    startedAt: current.startedAt ?? now,
    finishedAt: now,
  });
  return { ...next, updatedAt: now };
}

/** Record that the platform genuinely cannot run this stage (never "passed"). */
export function skipStage(run: BuildRun, id: BuildStageId, now: number, message: string): BuildRun {
  const next = replaceStage(run, id, { state: "skipped", message, startedAt: now, finishedAt: now });
  return { ...next, updatedAt: now };
}

export function failStage(run: BuildRun, id: BuildStageId, now: number, message: string): BuildRun {
  const next = replaceStage(run, id, { state: "failed", message, finishedAt: now });
  return { ...next, updatedAt: now };
}

export function setValidation(run: BuildRun, checks: BuildCheck[], now: number): BuildRun {
  return { ...run, validation: checks, updatedAt: now };
}

export function setChanges(run: BuildRun, changes: FileChange[], fileCount: number, now: number): BuildRun {
  return { ...run, changes, fileCount, updatedAt: now };
}

export function bumpAttempt(run: BuildRun, now: number): BuildRun {
  return { ...run, attempts: run.attempts + 1, updatedAt: now };
}

export function setPreviewUrl(run: BuildRun, url: string, now: number): BuildRun {
  return { ...run, previewUrl: url, updatedAt: now };
}

/**
 * Attach whatever the provider returned. `url` and `id` must come from the
 * provider — the run never invents them.
 */
export function setDeployment(run: BuildRun, ref: Partial<DeploymentRef> & { id: string }, now: number): BuildRun {
  const previous = run.deployment;
  const deployment: DeploymentRef = {
    id: ref.id,
    status: normalizeStatus(ref.status ?? previous?.status ?? "queued"),
    url: ref.url ?? previous?.url ?? null,
    slug: ref.slug ?? previous?.slug ?? null,
    environment: ref.environment ?? previous?.environment ?? run.environment,
    rollbackAvailable: ref.rollbackAvailable ?? previous?.rollbackAvailable ?? false,
    overridden: ref.overridden ?? previous?.overridden ?? false,
    error: ref.error ?? previous?.error ?? null,
  };
  return { ...run, deployment, updatedAt: now };
}

export function succeedRun(run: BuildRun, now: number): BuildRun {
  // Anti-fake guard: publishing was requested, so success requires a live
  // deployment. Building only requires the build stages to have completed.
  if (run.actions.publish && run.deployment?.status !== "live") return run;
  const unfinished = run.stages.filter((stage) => stage.state !== "completed" && stage.state !== "skipped");
  if (unfinished.length && run.actions.publish) return run;
  return { ...run, status: "succeeded", updatedAt: now, finishedAt: now };
}

export function cancelRun(run: BuildRun, now: number): BuildRun {
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled" || run.status === "awaiting_input") return run;
  return { ...run, status: "cancelled", cancelRequested: true, stages: run.stages.map((stage) => stage.state === "running" || stage.state === "queued" ? { ...stage, state: "skipped", finishedAt: now } : stage), updatedAt: now, finishedAt: now };
}

export function failRun(run: BuildRun, error: { code: string; message: string }, now: number): BuildRun {
  const active = run.stages.find((stage) => stage.state === "running");
  const withFailedStage = active ? failStage(run, active.id, now, error.message) : run;
  return {
    ...withFailedStage,
    status: "failed",
    error,
    updatedAt: now,
    finishedAt: now,
    // A run that stopped mid-publish is failed — never "live".
    deployment:
      withFailedStage.deployment && isActiveDeployment(withFailedStage.deployment.status)
        ? { ...withFailedStage.deployment, status: "failed", error: error.message }
        : withFailedStage.deployment,
  };
}

/** Stop a run with its progress saved. Nothing is reported as failed or done. */
export function pauseRun(run: BuildRun, continuation: RunContinuation, now: number): BuildRun {
  return {
    ...run,
    status: "paused",
    continuation,
    error: null,
    stages: run.stages.map((stage) => (stage.state === "running" ? { ...stage, state: "queued" as StageState, message: continuation.message } : stage)),
    updatedAt: now,
    finishedAt: null,
  };
}

/** Re-open a paused or interrupted run for its next execution session. */
export function reopenRun(run: BuildRun, now: number): BuildRun {
  return {
    ...run,
    status: "running",
    cancelRequested: false,
    continuation: null,
    error: null,
    segment: (run.segment ?? 1) + 1,
    stages: run.stages.map((stage) => (stage.state === "failed" || stage.state === "running" ? { ...stage, state: "queued" as StageState, finishedAt: null } : stage)),
    deployment: run.deployment && run.deployment.status === "failed" ? null : run.deployment,
    updatedAt: now,
    finishedAt: null,
  };
}

function isActiveDeployment(status: DeploymentStatus): boolean {
  return status === "queued" || status === "building" || status === "deploying";
}

/**
 * Fail a run that has gone silent (§4: "Publishing..." must never be
 * permanent). Uses the active stage's real timeout when one is running.
 */
export function applyStaleness(run: BuildRun, now: number): BuildRun {
  if (run.status !== "running" && run.status !== "requested") return run;
  const active = run.stages.find((stage) => stage.state === "running");
  const def = active ? stageDef(active.id) : null;
  const from = active?.startedAt ?? run.updatedAt;
  const limit = def?.timeoutMs ?? 180_000;
  if (now - from < limit) return run;
  const phase: RunContinuation["phase"] = active?.id === "publish" ? "publish" : active?.id === "validate" || active?.id === "build" || active?.id === "install" ? "repair" : "generate";
  const stale = failRun(
    run,
    {
      code: "BUILD_RUN_STALE",
      message: active
        ? `MATRIX stopped receiving updates during "${stageDef(active.id).label}". The build was marked failed — nothing was published by this card.`
        : "MATRIX stopped receiving updates for this build. Nothing was published by this card.",
    },
    now,
  );;
  // The work saved so far is still in the project: the run can be resumed.
  return { ...stale, continuation: { available: true, reason: "interrupted", phase, retryAt: null, message: "This build was interrupted. Its saved progress can be continued." } };
}

// ---------------------------------------------------------------------------
// Derived view state (what the components render)
// ---------------------------------------------------------------------------

export type StageProgress = {
  completed: number;
  total: number;
  activeId: BuildStageId | null;
  activeLabel: string;
  failedId: BuildStageId | null;
  percent: number;
};

export function stageProgress(run: BuildRun): StageProgress {
  const completed = run.stages.filter((stage) => stage.state === "completed" || stage.state === "skipped").length;
  const active = run.stages.find((stage) => stage.state === "running");
  const failed = run.stages.find((stage) => stage.state === "failed");
  return {
    completed,
    total: run.stages.length,
    activeId: active?.id ?? null,
    activeLabel: active ? stageDef(active.id).label : failed ? stageDef(failed.id).label : run.status === "succeeded" ? "Done" : "Queued",
    failedId: failed?.id ?? null,
    percent: Math.round((completed / run.stages.length) * 100),
  };
}

export type BuildRunCopy = {
  title: string;
  detail: string;
  glyph: "✓" | "●" | "✕" | "○";
  tone: "neutral" | "active" | "success" | "danger";
  /** Whether the chat row may show a live URL. */
  canOpenLive: boolean;
  liveUrl: string | null;
};

/** Chat-level copy: short, honest, and only "Published" when it is live. */
export function buildRunCopy(run: BuildRun): BuildRunCopy {
  const progress = stageProgress(run);
  const live = run.deployment?.status === "live" && run.deployment.url ? run.deployment.url : null;
  if (run.status === "succeeded" && live) {
    return { title: "Published successfully", detail: "Your project is live.", glyph: "✓", tone: "success", canOpenLive: true, liveUrl: live };
  }
  if (run.status === "succeeded") {
    return {
      title: run.workspaceOnly ? "Files saved to workspace" : run.actions.build ? "Build completed" : "Validation completed",
      detail: run.workspaceOnly
        ? "Project files are stored in the workspace; build and preview checks were not run."
        : run.actions.publish
          ? "The build passed but publishing did not report a live URL."
          : "Files are ready to preview.",
      glyph: "✓",
      tone: "success",
      canOpenLive: false,
      liveUrl: null,
    };
  }
  if (run.status === "awaiting_input") {
    return { title: "Waiting for your answer", detail: "No files were changed or published.", glyph: "○", tone: "neutral", canOpenLive: false, liveUrl: null };
  }
  if (run.status === "paused") {
    const waiting = run.continuation?.reason === "provider_unavailable";
    return {
      title: waiting ? "Waiting for the AI provider" : "Continuing…",
      detail: run.continuation?.message ?? "Progress is saved. MATRIX continues from where it stopped.",
      glyph: "●", tone: "active", canOpenLive: false, liveUrl: null,
    };
  }
  if (run.status === "cancelled") {
    return { title: "Build cancelled", detail: "The run was stopped before completion. No success was reported.", glyph: "○", tone: "neutral", canOpenLive: false, liveUrl: null };
  }
  if (run.status === "failed") {
    const failedPublish = progress.failedId === "publish" || run.deployment?.status === "failed";
    return {
      title: failedPublish ? "Publishing failed" : "Build failed",
      detail: run.error?.message ?? "MATRIX stopped before the deployment was live.",
      glyph: "✕",
      tone: "danger",
      canOpenLive: false,
      liveUrl: null,
    };
  }
  if (run.deployment?.status === "deploying") {
    return { title: "Publishing...", detail: "Uploading files to MATRIX hosting.", glyph: "●", tone: "active", canOpenLive: false, liveUrl: null };
  }
  return {
    title: "Building project",
    detail: `${progress.activeLabel} · ${progress.completed} / ${progress.total} steps`,
    glyph: "●",
    tone: "active",
    canOpenLive: false,
    liveUrl: null,
  };
}

// ---------------------------------------------------------------------------
// File change summary (§12, §13)
// ---------------------------------------------------------------------------

export type ChangeInput = string | { path: string; content?: string | null };

function changeEntry(input: ChangeInput): { path: string; content: string | null } {
  return typeof input === "string" ? { path: input, content: null } : { path: input.path, content: input.content ?? null };
}

/**
 * Diff two file lists. "modified" requires the content to actually differ, so
 * a rebuild that rewrote nothing never reports a phantom edit (§13).
 */
export function summarizeChanges(before: ChangeInput[], after: ChangeInput[]): FileChange[] {
  const previous = new Map(before.map((item) => { const e = changeEntry(item); return [e.path, e.content]; }));
  const current = new Map(after.map((item) => { const e = changeEntry(item); return [e.path, e.content]; }));
  const changes: FileChange[] = [];
  for (const [path, content] of current) {
    if (!previous.has(path)) changes.push({ path, kind: "created" });
    else if (previous.get(path) !== content) changes.push({ path, kind: "modified" });
  }
  for (const path of previous.keys()) if (!current.has(path)) changes.push({ path, kind: "removed" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function changeCounts(changes: FileChange[]): { created: number; modified: number; removed: number } {
  return {
    created: changes.filter((change) => change.kind === "created").length,
    modified: changes.filter((change) => change.kind === "modified").length,
    removed: changes.filter((change) => change.kind === "removed").length,
  };
}

// ---------------------------------------------------------------------------
// Persistence snapshots
// ---------------------------------------------------------------------------

/** Firestore/JSON-safe snapshot stored on the chat message so the published
 *  card survives a reload without re-running anything. */
export type BuildRunSnapshot = {
  run_id: string;
  project_id?: string | null;
  project_title?: string | null;
  conversation_id?: string | null;
  task_id?: string | null;
  status: BuildRunStatus;
  stage_states: Array<[BuildStageId, StageState]>;
  workspace_only?: boolean;
  deployment_status: DeploymentStatus | null;
  url: string | null;
  environment: BuildEnvironment;
  file_count: number;
  attempts: number;
  error_code: string | null;
  preview_url?: string | null;
  /** Model that actually produced the files (absent on runs before this field). */
  model?: string;
  provider?: string;
  design_direction?: string;
};

export function toRunSnapshot(run: BuildRun): BuildRunSnapshot {
  return {
    run_id: run.id,
    project_id: run.projectId ?? null,
    project_title: run.projectTitle ?? null,
    conversation_id: run.conversationId ?? null,
    task_id: run.taskId ?? null,
    status: run.status,
    stage_states: run.stages.map((stage) => [stage.id, stage.state]),
    workspace_only: run.workspaceOnly === true,
    deployment_status: run.deployment?.status ?? null,
    url: run.deployment?.status === "live" ? run.deployment.url : null,
    environment: run.environment,
    file_count: run.fileCount,
    attempts: run.attempts,
    error_code: run.error?.code ?? null,
    preview_url: run.previewUrl ?? null,
    ...(run.model ? { model: run.model.model, provider: run.model.provider } : {}),
    ...(run.design ? { design_direction: run.design.direction } : {}),
  };
}

export function snapshotFromRun(run: BuildRun): BuildRunSnapshot {
  return toRunSnapshot(run);
}

/**
 * Rebuild a minimal run from a persisted snapshot (chat history). States come
 * from storage only — nothing is promoted to "succeeded" here.
 */
export function runFromSnapshot(snapshot: Partial<BuildRunSnapshot> & { run_id: string }, now: number): BuildRun {
  const stages = initialStages().map((stage) => {
    const stored = snapshot.stage_states?.find(([id]) => id === stage.id);
    if (!stored) return stage;
    return { ...stage, state: stored[1], finishedAt: stage.finishedAt ?? (stored[1] === "running" ? null : now) };
  });
  const status: BuildRunStatus =
    snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "running" || snapshot.status === "requested" || snapshot.status === "cancelled" || snapshot.status === "awaiting_input" || snapshot.status === "paused"
      ? snapshot.status
      : "failed";
  return {
    id: snapshot.run_id,
    projectId: snapshot.project_id ?? null,
    projectTitle: snapshot.project_title ?? null,
    conversationId: snapshot.conversation_id ?? null,
    requestId: null,
    taskId: snapshot.task_id ?? null,
    cancelRequested: snapshot.status === "cancelled",
    status,
    actions: { build: true, publish: status === "succeeded" && snapshot.workspace_only !== true, preview: false },
    workspaceOnly: snapshot.workspace_only === true,
    environment: snapshot.environment === "preview" ? "preview" : "production",
    stages,
    changes: [],
    validation: null,
    attempts: snapshot.attempts ?? 0,
    maxAttempts: 2,
    fileCount: snapshot.file_count ?? 0,
    previewUrl: snapshot.preview_url ?? null,
    model: snapshot.model && snapshot.provider ? { provider: snapshot.provider, model: snapshot.model } : null,
    deployment:
      snapshot.deployment_status && snapshot.deployment_status !== "none"
        ? {
            id: snapshot.run_id,
            status: normalizeStatus(snapshot.deployment_status),
            url: snapshot.url ?? null,
            slug: null,
            environment: snapshot.environment === "preview" ? "preview" : "production",
            rollbackAvailable: false,
            overridden: false,
            error: null,
          }
        : null,
    error: snapshot.error_code ? { code: snapshot.error_code, message: "This build did not finish successfully." } : null,
    logs: [],
    startedAt: now,
    updatedAt: now,
    finishedAt: status === "succeeded" || status === "failed" || status === "awaiting_input" ? now : null,
  };
}
