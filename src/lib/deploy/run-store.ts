// =============================================================================
// Build run ↔ Firestore document
//
// The persisted run is the single source of truth the chat card, the project
// dashboard and a page reload all read from. Serialization is deliberately
// defensive: Firestore rejects `undefined`, and a truncated or foreign record
// must never be able to look like a successful publish.
// =============================================================================

import { normalizeStatus, type DeploymentStatus } from "@/lib/deploy/status";
import {
  BUILD_STAGES,
  type BuildActions,
  type BuildEnvironment,
  type BuildLogLine,
  type BuildRun,
  type BuildRunStatus,
  type BuildStage,
  type BuildStageId,
  type FileChange,
  type StageState,
} from "@/lib/deploy/stages";
import type { BuildCheck, BuildReport } from "@/lib/deploy/validate";

/** Stored logs are capped tighter than in-memory ones: the doc has a size budget. */
export const STORED_LOG_LIMIT = 80;
const LOG_LIMIT = STORED_LOG_LIMIT;
const CHANGE_LIMIT = 200;

type Json = Record<string, unknown>;

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

const STAGE_STATES: StageState[] = ["queued", "running", "completed", "failed", "skipped"];
const RUN_STATUSES: BuildRunStatus[] = ["requested", "running", "succeeded", "failed"];

/** Firestore-safe copy of a run (bounded, no undefined, no functions). */
export function toFirestoreRun(run: BuildRun): Json {
  return {
    id: run.id,
    projectId: run.projectId ?? null,
    conversationId: run.conversationId ?? null,
    requestId: run.requestId ?? null,
    status: run.status,
    environment: run.environment,
    actions: { build: run.actions.build, publish: run.actions.publish, preview: run.actions.preview, fix: run.actions.fix === true },
    stages: run.stages.map((stage) => ({
      id: stage.id,
      state: stage.state,
      message: stage.message.slice(0, 400),
      startedAt: stage.startedAt ?? null,
      finishedAt: stage.finishedAt ?? null,
    })),
    changes: run.changes.slice(0, CHANGE_LIMIT).map((change) => ({ path: change.path, kind: change.kind })),
    validation: run.validation ? serializeReport(run.validation) : null,
    attempts: run.attempts,
    maxAttempts: run.maxAttempts,
    fileCount: run.fileCount,
    previewUrl: run.previewUrl ?? null,
    deployment: run.deployment
      ? {
          id: run.deployment.id,
          status: run.deployment.status,
          url: run.deployment.url ?? null,
          slug: run.deployment.slug ?? null,
          environment: run.deployment.environment,
          rollbackAvailable: run.deployment.rollbackAvailable,
          overridden: run.deployment.overridden,
          error: run.deployment.error ?? null,
        }
      : null,
    error: run.error ? { code: run.error.code, message: run.error.message.slice(0, 600) } : null,
    logs: run.logs.slice(-LOG_LIMIT).map((line) => ({
      at: line.at,
      stage: line.stage ?? null,
      level: line.level,
      message: line.message.slice(0, 400),
    })),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
  };
}

function serializeReport(report: BuildReport | BuildCheck[]): Json {
  const checks = Array.isArray(report) ? report : report.checks;
  return {
    checks: checks.slice(0, 12).map((check) => ({
      id: check.id,
      label: check.label,
      status: check.status,
      message: check.message.slice(0, 300),
      issues: check.issues.slice(0, 24).map((issue) => ({
        path: issue.path,
        line: issue.line ?? null,
        message: issue.message.slice(0, 300),
        severity: issue.severity,
      })),
    })),
    blocking: Array.isArray(report) ? report.some((check) => check.status === "failed") : report.blocking,
    errors: Array.isArray(report) ? 0 : report.errors,
    warnings: Array.isArray(report) ? 0 : report.warnings,
    summary: Array.isArray(report) ? "" : report.summary.slice(0, 300),
  };
}

function readStageStates(value: unknown): Map<BuildStageId, BuildStage> {
  const map = new Map<BuildStageId, BuildStage>();
  if (!Array.isArray(value)) return map;
  const known = BUILD_STAGES.map((stage) => stage.id) as string[];
  for (const raw of value) {
    const item = (raw ?? {}) as Json;
    const id = str(item.id);
    if (!known.includes(id)) continue;
    const state = STAGE_STATES.includes(item.state as StageState) ? (item.state as StageState) : "queued";
    map.set(id as BuildStageId, {
      id: id as BuildStageId,
      state,
      message: str(item.message),
      startedAt: typeof item.startedAt === "number" ? item.startedAt : null,
      finishedAt: typeof item.finishedAt === "number" ? item.finishedAt : null,
    });
  }
  return map;
}

/**
 * Rebuild a run from storage. Unknown or missing status values degrade to
 * "failed" rather than to a success-looking state.
 */
export function runFromFirestore(raw: unknown, now: number): BuildRun | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Json;
  const id = str(data.id);
  if (!id) return null;
  const states = readStageStates(data.stages);
  const stages: BuildStage[] = BUILD_STAGES.map(
    (stage) =>
      states.get(stage.id) ?? {
        id: stage.id,
        state: "queued" as StageState,
        message: "",
        startedAt: null,
        finishedAt: null,
      },
  );
  const actions = (data.actions ?? {}) as Json;
  const deploymentRaw = (data.deployment ?? null) as Json | null;
  const errorRaw = (data.error ?? null) as Json | null;
  const status: BuildRunStatus = RUN_STATUSES.includes(data.status as BuildRunStatus) ? (data.status as BuildRunStatus) : "failed";
  return {
    id,
    projectId: nullableStr(data.projectId),
    conversationId: nullableStr(data.conversationId),
    requestId: nullableStr(data.requestId),
    status,
    actions: {
      build: actions.build !== false,
      publish: actions.publish === true,
      preview: actions.preview === true,
      fix: actions.fix === true,
    } satisfies BuildActions,
    environment: (data.environment === "preview" ? "preview" : "production") as BuildEnvironment,
    stages,
    changes: Array.isArray(data.changes)
      ? (data.changes as Json[])
          .map((change) => ({ path: str(change.path), kind: str(change.kind) as FileChange["kind"] }))
          .filter((change) => change.path && ["created", "modified", "removed"].includes(change.kind))
      : [],
    validation: readValidation(data.validation),
    attempts: num(data.attempts),
    maxAttempts: num(data.maxAttempts, 2),
    fileCount: num(data.fileCount),
    previewUrl: nullableStr(data.previewUrl),
    deployment:
      deploymentRaw && str(deploymentRaw.id)
        ? {
            id: str(deploymentRaw.id),
            status: normalizeStatus(deploymentRaw.status),
            url: nullableStr(deploymentRaw.url),
            slug: nullableStr(deploymentRaw.slug),
            environment: (deploymentRaw.environment === "preview" ? "preview" : "production") as BuildEnvironment,
            rollbackAvailable: deploymentRaw.rollbackAvailable === true,
            overridden: deploymentRaw.overridden === true,
            error: nullableStr(deploymentRaw.error),
          }
        : null,
    error: errorRaw ? { code: str(errorRaw.code, "BUILD_RUN_FAILED"), message: str(errorRaw.message, "The build stopped unexpectedly.") } : null,
    logs: Array.isArray(data.logs)
      ? (data.logs as Json[]).map(
          (line): BuildLogLine => ({
            at: num(line.at, now),
            stage: (nullableStr(line.stage) as BuildStageId | null) ?? null,
            level: (["info", "warn", "error", "success"].includes(String(line.level)) ? line.level : "info") as BuildLogLine["level"],
            message: str(line.message),
          }),
        )
      : [],
    startedAt: num(data.startedAt, now),
    updatedAt: num(data.updatedAt, now),
    finishedAt: typeof data.finishedAt === "number" ? data.finishedAt : null,
  };
}

function readValidation(value: unknown): BuildCheck[] | null {
  if (!value || typeof value !== "object") return null;
  const checks = (value as Json).checks;
  if (!Array.isArray(checks)) return null;
  return (checks as Json[]).map(
    (check): BuildCheck => ({
      id: (["dependencies", "syntax", "build", "routes", "assets"].includes(String(check.id)) ? check.id : "build") as BuildCheck["id"],
      label: str(check.label, "Check"),
      status: (["passed", "failed", "skipped"].includes(String(check.status)) ? check.status : "skipped") as BuildCheck["status"],
      message: str(check.message),
      issues: Array.isArray(check.issues)
        ? (check.issues as Json[]).map((issue) => ({
            path: str(issue.path),
            line: typeof issue.line === "number" ? issue.line : undefined,
            message: str(issue.message),
            severity: (issue.severity === "warning" ? "warning" : "error") as "error" | "warning",
          }))
        : [],
    }),
  );
}

/** Deployment state the chat card may show, derived only from stored data. */
export function storedDeploymentStatus(run: BuildRun | null): DeploymentStatus {
  return run?.deployment?.status ?? "none";
}
