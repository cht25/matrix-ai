// =============================================================================
// MATRIX build pipeline (§1)
//
//   PLAN → GENERATE FILES → DEPENDENCIES → BUILD → VALIDATE → AUTO-FIX → PUBLISH
//
// Every transition is produced by something that actually happened:
//
//   Planning    → project resolved/created, address checked against the host
//   Generating  → a provider call whose files were parsed and really written
//   Deps/Build  → the bundler ran over the stored project files
//   Validating  → the local build checker's verdict
//   Publishing  → DeploymentProvider.deploy() returned a live deployment
//
// Failures stop the pipeline (unless the user explicitly overrides §14) and a
// silent run is failed by staleness, so "Publishing..." can never hang (§4).
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import type { AIMessage } from "@/lib/ai/groq";
import { completeWithModel, type CompletedAIResponse } from "@/lib/ai/executor";
import { AIConfigurationError, type AIRouteTarget } from "@/lib/ai/config";
import { resolvePool } from "@/lib/ai/models/pool";
import { modelById, modelLabel, type ModelStrength } from "@/lib/ai/models/registry";
import { completeWithRole } from "@/lib/ai/orchestrator/run";
import { MATRIX_MODEL_LABEL } from "@/lib/ai/model";
import {
  classifyDesignRevision, createDesignSpec, designFingerprint, designPlanPrompt, formatDesignSpecForPrompt, isWebsiteRequest,
  mergeModelDesignSpec, parseStoredDesignSpec, reviseDesignSpec, serializeDesignSpec, type DesignRevision, type SiteDesignSpec,
} from "@/lib/design/site-spec";
import { designQualityCheck, significantDesignIssues } from "@/lib/deploy/design-quality";
import { AGENT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { agentGenerationIncomplete, formatProjectFilesForContext, parseAgentResponse, shouldWithholdProjectFile } from "@/lib/ai/agent";
import { classifyAgentOutput, transitionAgentExecution, type AgentExecutionState, type PendingAgentTask } from "@/lib/ai/agent-execution";
import { planFromRequest, type BuildIntent } from "@/lib/ai/build-intent";
import { generateImage } from "@/lib/ai/image/generate";
import { isImageGenerationConfigured } from "@/lib/ai/image/config";
import { applyProjectFiles, ensureAgentProject, loadProjectFiles, saveProjectVersion } from "@/lib/server/projects";
import { bindConversationProject, resolveProjectContext } from "@/lib/server/project-resolution";
import { appendCheckpoint, bindBuildTask, syncBuildTask, type CheckpointStep } from "@/lib/server/agent-tasks";
import { PROJECT_LIMITS, type ProjectFile } from "@/lib/projects/paths";
import {
  applyStaleness, beginStage, buildRunCopy, cancelRun, completeStage, createBuildRun, failRun, failStage,
  setDeployment, setChanges, setPreviewUrl, setValidation, skipStage, stageProgress, succeedRun,
  summarizeChanges, bumpAttempt, pauseRun, reopenRun, MAX_RUN_SEGMENTS,
  toRunSnapshot,
  type BuildActions, type BuildEnvironment, type BuildLogLine, type BuildRun, type BuildStageId,
} from "@/lib/deploy/stages";
import { blockingIssues, formatIssues, type BuildReport } from "@/lib/deploy/validate";
import type { DeploymentProvider } from "@/lib/deploy/provider";
import { toFirestoreRun, runFromFirestore } from "@/lib/deploy/run-store";
import { deployVerdict, type ClassifiedIssue } from "@/lib/deploy/classify";
import { repairStopCopy, runRepairLoop, type RepairModel } from "@/lib/deploy/repair";
import { AIProviderError } from "@/lib/ai/provider-error";
import { nextAvailability } from "@/lib/ai/accounts";
import { clearResumeState, saveResumeState, type ResumePhase, type ResumeState } from "@/lib/server/continuation";

export type ImageAssetRequest = { name: string; prompt: string };

export type BuildPipelineInput = {
  d: Db;
  user: SessionUser;
  provider: DeploymentProvider;
  runId: string;
  projectId?: string | null;
  workspaceProjectId?: string | null;
  conversationId?: string | null;
  requestId?: string | null;
  prompt: string;
  taskContext?: PendingAgentTask | null;
  actions: BuildActions;
  environment?: BuildEnvironment;
  slug?: string | null;
  /** Explicit user override: publish despite failing checks (§14). */
  allowOverride?: boolean;
  imageRequests?: ImageAssetRequest[];
  maxFixAttempts?: number;
  taskId?: string | null;
  /** Text/code files the user attached: stored as real project files first. */
  attachments?: Array<{ path: string; content: string }>;
  /** Store the assistant turn in the conversation (skipped for temp chats). */
  isTemporary?: boolean;
  /** Code-mode file generation persists source but deliberately skips build claims. */
  workspaceOnly?: boolean;
  chatMode?: "code" | "agent";
  onEvent?: (event: { run: BuildRun; stage?: BuildStageId; copy?: ReturnType<typeof buildRunCopy> }) => void;
  /**
   * Continue an earlier execution session of the SAME run (same chat, project
   * and task). The stored run is reopened and work starts at `state.phase`.
   */
  resume?: { state: ResumeState; run: BuildRun } | null;
  /** Time this execution session may spend on model work (tests shorten it). */
  aiBudgetMs?: number;
};

export type BuildPipelineResult = { run: BuildRun; reply: string; projectId: string | null };

/** Static hosting cannot execute server runtimes. Keep source editing available
 * for these languages without fabricating a successful web deployment. */
export function requiresNonStaticRuntime(prompt: string): boolean {
  return /\b(?:python|django|flask|fastapi|rust|cargo|golang|go\s+(?:app|service|program|server|cli)|java|spring\s+boot|c\+\+|c#|dotnet|\.net|php|laravel|ruby|rails|kotlin|swift|dart|flutter|node\.js\s+server|express\s+server|backend|api\s+server|command.line|cli\s+app)(?:\b|(?<=[+#]))/i.test(prompt);
}

const MAX_FIX_ATTEMPTS = 4;
/** The build route may run for 300 s; leave room to validate, publish and persist. */
const AI_BUDGET_MS = 235_000;

/** Append the design-quality verdict to the provider's build report. */
function withDesignQuality(report: BuildReport, files: ProjectFile[], spec: SiteDesignSpec | null): BuildReport {
  const quality = designQualityCheck(files, {
    expectedPages: spec?.pages ?? [],
    requirePages: spec?.userConstraints.some((line) => /separate pages/i.test(line)) === true,
  });
  const checks = [...report.checks.filter((check) => check.id !== "design"), quality];
  const errors = checks.reduce((sum, check) => sum + check.issues.filter((issue) => issue.severity === "error").length, 0);
  const warnings = checks.reduce((sum, check) => sum + check.issues.filter((issue) => issue.severity === "warning").length, 0);
  const blocking = checks.some((check) => check.status === "failed");
  return {
    checks, blocking, errors, warnings,
    summary: blocking
      ? `${errors} problem${errors === 1 ? "" : "s"} must be fixed before publishing.`
      : `All supported checks passed${warnings ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`,
  };
}

function sameContent(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();
}

/** Full current source for a repair/polish request (bounded). */
function sourceContext(files: ProjectFile[], prompt: string): string {
  return formatProjectFilesForContext(files, prompt, { maxTotalChars: 160_000 }).text;
}
const MAX_IMAGE_ASSETS = 4;

function hashPrompt(prompt: string): string {
  return crypto.createHash("sha1").update(prompt.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export async function runBuildPipeline(input: BuildPipelineInput): Promise<BuildPipelineResult> {
  const { d, user, provider, runId } = input;
  const now = () => Date.now();
  const nonStatic = requiresNonStaticRuntime(input.prompt);
  const workspaceOnly = !input.actions.publish && !input.actions.preview &&
    ((input.workspaceOnly === true && input.chatMode === "code") || (nonStatic && input.actions.build));
  let reply = "";
  let executionState: AgentExecutionState = "PLANNING";
  let resolvedProjectId: string | null = input.projectId ?? null;
  const done = (run: BuildRun): BuildPipelineResult => ({ run, reply, projectId: resolvedProjectId });
  const aiDeadline = Date.now() + (input.aiBudgetMs ?? AI_BUDGET_MS);
  let designSpec: SiteDesignSpec | null = null;
  const resumed = input.resume ?? null;
  const resumePhase: ResumePhase | null = resumed?.state.phase ?? null;
  let phase: ResumePhase = resumePhase ?? "generate";
  let progressSaved = false;
  let run = resumed ? { ...reopenRun(resumed.run, now()), maxAttempts: Math.min(input.maxFixAttempts ?? resumed.run.maxAttempts ?? MAX_FIX_ATTEMPTS, 8) } : createBuildRun({
    id: runId,
    projectId: input.projectId ?? null,
    conversationId: input.conversationId ?? null,
    requestId: input.requestId ?? null,
    taskId: input.taskId ?? null,
    actions: input.actions,
    workspaceOnly,
    environment: input.environment ?? "production",
    maxAttempts: Math.min(input.maxFixAttempts ?? MAX_FIX_ATTEMPTS, 8),
    now: now(),
  });

  if (input.taskId && !resumed) await bindBuildTask(d, user, input.taskId, { project_id: null, build_run_id: runId });
  const emit = async (stage?: BuildStageId): Promise<void> => {
    await persist(d, runId, run);
    if (run.taskId) {
      try { await syncBuildTask(d, user, run.taskId, run); }
      catch (error) { console.error("[build] task sync failed", error instanceof Error ? error.message : "unknown"); }
    }
    input.onEvent?.({ run, stage, copy: buildRunCopy(run) });
  };
  const checkpointSteps: Partial<Record<BuildStageId, CheckpointStep>> = { plan: "plan", generate: "edit", build: "build", validate: "test", publish: "deploy" };
  const checkpoint = async (stage: BuildStageId | undefined, state: "ok" | "failed", detail: string) => {
    const step = stage ? checkpointSteps[stage] : undefined;
    if (!run.taskId || !step) return;
    try { await appendCheckpoint(d, user, run.taskId, { step, state, detail: detail.slice(0, 500) }); } catch { /* terminal task state is stored on the header */ }
  };
  const cancelled = async (): Promise<boolean> => {
    const snap = await d.collection("build_runs").doc(runId).get();
    return snap.data()?.cancelRequested === true || snap.data()?.cancel_requested === true || snap.data()?.status === "cancelled";
  };

  const note = (stage: BuildStageId | null, level: BuildLogLine["level"], message: string): void => {
    run = { ...run, logs: [...run.logs, { at: now(), stage, level, message }].slice(-160) };
  };

  const begin = async (stage: BuildStageId, message: string): Promise<void> => {
    if (await cancelled()) throw new RpcError("CANCELLED", 409);
    if (stage === "build") executionState = transitionAgentExecution(executionState, "build_started");
    if (stage === "validate") executionState = transitionAgentExecution(executionState, "validation_started");
    if (stage === "publish") executionState = transitionAgentExecution(executionState, "deployment_started");
    run = beginStage(run, stage, now(), message);
    note(stage, "info", message);
    await emit(stage);
  };

  const finish = async (stage: BuildStageId, message: string): Promise<void> => {
    run = completeStage(run, stage, now(), message);
    note(stage, "success", message);
    await checkpoint(stage, "ok", message);
    await emit(stage);
  };

  const skipped = async (stage: BuildStageId, message: string): Promise<void> => {
    if (stage === "build") executionState = transitionAgentExecution(executionState, "build_started");
    if (stage === "validate") executionState = transitionAgentExecution(executionState, "validation_started");
    if (stage === "publish") executionState = transitionAgentExecution(executionState, "deployment_started");
    run = beginStage(run, stage, now(), message);
    run = skipStage(run, stage, now(), message);
    note(stage, "info", message);
    await emit(stage);
  };

  const abort = async (code: string, message: string, stage?: BuildStageId): Promise<BuildPipelineResult> => {
    await checkpoint(stage, "failed", message);
    if (stage) run = failStage(run, stage, now(), message);
    executionState = transitionAgentExecution(executionState, "error");
    run = failRun(run, { code, message }, now());
    note(stage ?? null, "error", message);
    await emit(stage);
    return done(run);
  };

  // ---- continuation --------------------------------------------------------
  // What a later execution session needs to carry on with this same run. The
  // files themselves are already in project storage.
  const resumeState = (unresolved: string[] = []): ResumeState => ({
    prompt: input.prompt,
    projectId: resolvedProjectId,
    workspaceProjectId: input.workspaceProjectId ?? null,
    conversationId: input.conversationId ?? null,
    taskId: input.taskId ?? null,
    requestId: input.requestId ?? null,
    actions: input.actions,
    chatMode: input.chatMode ?? "agent",
    environment: input.environment ?? "production",
    slug: input.slug ?? null,
    allowOverride: input.allowOverride === true,
    isTemporary: input.isTemporary === true,
    workspaceOnly: input.workspaceOnly === true,
    maxFixAttempts: input.maxFixAttempts ?? null,
    phase,
    segment: run.segment ?? 1,
    messageId: resumed?.state.messageId ?? null,
    completed: run.stages.filter((stage) => stage.state === "completed" || stage.state === "skipped").map((stage) => stage.id),
    pending: run.stages.filter((stage) => stage.state !== "completed" && stage.state !== "skipped").map((stage) => stage.id),
    unresolved,
    attemptsUsed: run.attempts,
    revision: null,
  });
  const saveProgress = async (unresolved: string[] = []): Promise<void> => {
    try {
      await saveResumeState(d, runId, resumeState(unresolved));
      progressSaved = true;
    } catch (error) {
      note(null, "warn", `Progress record could not be saved (${error instanceof Error ? error.message.slice(0, 80) : "storage error"}); the project files are unaffected.`);
    }
  };
  /**
   * End this execution session without ending the request. The run stays
   * open: the next session (same chat, same project) starts at `phase`.
   */
  const pause = async (reason: "time_limit" | "provider_unavailable", message: string, retryAt: number | null, unresolved: string[] = [], stage?: BuildStageId): Promise<BuildPipelineResult> => {
    const available = (run.segment ?? 1) < MAX_RUN_SEGMENTS;
    if (!available) {
      return await abort("CONTINUATION_LIMIT", `${message} This request already used ${MAX_RUN_SEGMENTS} execution sessions, so it was stopped. Everything saved so far is in the project — send a follow-up to carry on from there.`, stage);
    }
    await saveProgress(unresolved);
    if (!progressSaved) return await abort("BUILD_RUN_FAILED", `${message} The progress record could not be saved, so the run cannot continue automatically. Saved files are still in the project.`, stage);
    run = pauseRun(run, { available, reason, phase, retryAt, message }, now());
    note(stage ?? null, "warn", message);
    await emit(stage);
    return done(run);
  };
  /** Was this failure the provider being unavailable/limited (as opposed to a bad request)? */
  const providerOutage = (error: unknown): { outage: boolean; retryAt: number | null } => {
    const text = error instanceof Error ? error.message : "";
    const typed = error instanceof AIProviderError ? error : null;
    const outage = typed ? typed.retryable : /rate[_ ]limit|provider_unavailable|timeout|network|empty_response|cool(?:ing)?[- ]?down|no model available|deadline/i.test(text);
    const model = run.model?.model ?? "";
    return { outage, retryAt: typed?.retryAt ?? (outage && model ? nextAvailability(model) : null) };
  };

  try {
    await emit();
    if (resumed) note(null, "info", `Continuing in a new execution session (${run.segment} of up to ${MAX_RUN_SEGMENTS}) — same chat, same project. Resuming at: ${phase}.`);
    // ---------------------------------------------------------------- plan --
    await begin("plan", "Resolving project, entry page and public address.");
    if (nonStatic && (input.actions.publish || input.actions.preview)) {
      return await abort("RUNTIME_NOT_SUPPORTED", "MATRIX hosting supports static HTML/CSS/JavaScript only. This request needs an isolated runtime/build provider; no preview or deployment was attempted. Ask to save the source without preview/publishing, or connect a compatible host.", "plan");
    }
    const plan = planFromRequest(input.prompt || "MATRIX project");
    const resolution = await resolveProjectContext(d, user, {
      projectId: input.projectId, workspaceProjectId: input.workspaceProjectId,
      conversationId: input.conversationId, prompt: input.prompt, hasAttachments: Boolean(input.attachments?.length),
    });
    let projectId = resolution.projectId;
    if (resolution.mode === "create" && (input.actions.build || input.actions.publish)) {
      const ensured = await ensureAgentProject(d, user, {
        conversation_id: input.isTemporary ? null : input.conversationId,
        title: plan.title.slice(0, 80),
        forceNew: resolution.forceNew === true,
      });
      projectId = ensured.id;
      note("plan", "info", `Created project "${ensured.title}".`);
    }
    resolvedProjectId = projectId;
    let initialRevision = 0;
    if (projectId) {
      const projectMeta = await d.collection("projects").doc(projectId).get();
      if (!projectMeta.exists || projectMeta.data()?.owner_id !== user.uid || projectMeta.data()?.archived_at) {
        throw new RpcError("PROJECT_NOT_FOUND", 404, "The selected project is no longer accessible. Choose a project you own.");
      }
      initialRevision = Number(projectMeta.data()?.revision ?? 0);
      run = { ...run, projectId, projectTitle: String(projectMeta.data()?.title ?? plan.title).slice(0, 80) };
      note("plan", "info", `${resolution.mode.toUpperCase()} MODE · ${resolution.source} · project ${projectId} · revision ${Number(projectMeta.data()?.revision ?? 0)}.`);
      if (input.conversationId && !input.isTemporary) await bindConversationProject(d, user, input.conversationId, projectId);
      if (input.taskId) await bindBuildTask(d, user, input.taskId, { project_id: projectId, build_run_id: runId });
    }
    if (!projectId) return await abort("PROJECT_REQUIRED", "There is no project to build yet. Describe what to create and I will make it.", "plan");
    // Attached source files are stored as project records before anything else
    // happens, so validation, preview and publishing all see the user's real
    // code instead of a paraphrase of it (§12).
    if (input.attachments?.length) {
      const files = input.attachments
        .filter((item) => item.path && item.content.trim())
        .slice(0, 8)
        .map((item) => ({
          path: item.path.slice(0, 200),
          content: item.content.slice(0, 200_000),
          language: item.path.split(".").pop() ?? "text",
        }));
      if (files.length) {
        try {
          const applied = await applyProjectFiles(d, user, { project_id: projectId, files, source: "agent", expected_revision: initialRevision });
          note("plan", "info", `Stored ${applied.count} attached file${applied.count === 1 ? "" : "s"} in the project.`);
          await emit("plan");
        } catch (error) {
          const code = error instanceof RpcError ? error.code : "FILE_WRITE_FAILED";
          return await abort(code, code === "PROJECT_REVISION_CONFLICT" ? "The project changed while attachments were being saved. Refresh the Workspace and retry; no newer source was overwritten." : "One of the attached files could not be stored in the project, so nothing was built from it.", "plan");
        }
      }
    }
    const before = await loadProjectFiles(d, projectId);
    const projectFilesContext = formatProjectFilesForContext(before, input.prompt);
    const projectRecord = (await d.collection("projects").doc(projectId).get()).data() ?? {};
    if (projectRecord.owner_id !== user.uid) {
      return await abort("PROJECT_ACCESS_DENIED", "This project no longer belongs to the current user. No files were changed.", "plan");
    }
    let sourceRevision = Number(projectRecord.revision ?? 0);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
      return await abort("PROJECT_CONTEXT_MISSING", "The project's source revision is invalid. No files were generated; reopen the project.", "plan");
    }
    const executionContext = {
      ownerId: user.uid, chatId: input.conversationId ?? null, projectId,
      mode: resolution.mode, projectRoot: `projects/${projectId}/files`,
      sourceRevision, manifest: Array.isArray(projectRecord.file_manifest)
        ? projectRecord.file_manifest : before.map((file) => ({ path: file.path })),
      build: { framework: String(projectRecord.framework ?? "html"), command: String(projectRecord.build_command ?? "MATRIX static bundler"), entry: String(projectRecord.entry_point ?? "none") },
      deployment: { id: projectRecord.live_deployment_id ?? null, slug: projectRecord.live_slug ?? null, environment: input.environment ?? "production" },
    };
    const existingProjectContext = [
      `Execution context: ${executionContext.mode.toUpperCase()} MODE; project root ${executionContext.projectRoot}; source revision ${executionContext.sourceRevision}; name ${String(projectRecord.title ?? plan.title).slice(0, 80)}; framework ${executionContext.build.framework}; build command ${executionContext.build.command}; entry ${executionContext.build.entry}; deployment ${String(executionContext.deployment.id ?? "none")}; live slug ${String(executionContext.deployment.slug ?? "none")}. Persisted manifest: ${JSON.stringify(executionContext.manifest).slice(0, 4000)}. These metadata and saved files, not chat memory, are authoritative.`,
      `Saved file index: ${before.map((file) => file.path).join(", ") || "empty"}.`,
      projectFilesContext.text,
    ].filter(Boolean).join("\n\n");
    const withheldExistingPaths = new Set(projectFilesContext.omittedPaths.map((path) => path.toLowerCase()));
    const slug = (input.slug ?? "").trim() || plan.slug;
    await finish("plan", `Project ready · ${before.length} existing file${before.length === 1 ? "" : "s"} · address /s/${slug}.`);

    // ------------------------------------------------------ model team --
    // Every model works on the SAME project (one workspace, one revision
    // counter): a model's files are only saved through applyProjectFiles with
    // the revision they were based on, so a stale write is rejected instead of
    // overwriting newer work. Each stage is one model's responsibility; when
    // that model cannot run, the next suitable enabled model takes the stage.
    let team: AIRouteTarget[] | null = null;
    let authorIndex = 0;
    const getTeam = async (): Promise<AIRouteTarget[]> => {
      if (team) return team;
      const resolved = await resolvePool(d, user.uid);
      for (const skipped of resolved.skipped) note("generate", "warn", `${skipped.label} is enabled but not available: ${skipped.reason}`);
      // Stages write or repair real project files, so only code-capable models take part.
      const capable = resolved.targets.filter((target) => modelById(target.model)?.strengths.includes("coding"));
      team = capable.length ? capable : resolved.targets.slice(0, 1);
      return team;
    };
    type TeamStage = "design" | "implement" | "repair" | "review";
    const STAGE_NEEDS: Record<TeamStage, readonly ModelStrength[]> = {
      design: ["planning", "writing"],
      implement: ["coding", "planning"],
      repair: ["review", "coding", "reasoning"],
      review: ["review", "writing", "coding"],
    };
    const completeAs = async (stage: TeamStage, request: Parameters<typeof completeWithModel>[1]): Promise<CompletedAIResponse> => {
      const members = await getTeam();
      if (!members.length) throw new AIConfigurationError(true);
      // The lead writes the files. Design, repair and review go to a
      // different model when one is enabled, so work is checked by a model
      // that did not produce it.
      const options = stage === "implement" ? { prefer: authorIndex } : members.length > 1 ? { avoid: stage === "design" ? 0 : authorIndex } : {};
      const { completed, attempts } = await completeWithRole(members, STAGE_NEEDS[stage], request, { ...options, maxWaitMs: 8_000 });
      for (const attempt of attempts) {
        if (attempt.outcome !== "ok") note(stage === "repair" || stage === "review" ? "validate" : "generate", "warn", `${attempt.label} could not take the ${stage} stage (${attempt.detail}); continuing with the next model.`);
      }
      if (!completed) throw new Error(attempts.map((attempt) => `${attempt.label}: ${attempt.detail}`).join("; ") || "no model available");
      if (stage === "implement") authorIndex = Math.max(0, members.indexOf(completed.target));
      if (members.length > 1) note(stage === "repair" || stage === "review" ? "validate" : "generate", "info", `${stage[0].toUpperCase()}${stage.slice(1)}: ${modelLabel(completed.target.model)}.`);
      return completed;
    };

    // ------------------------------------------------------------ generate --
    let files = before;
    const wantsGeneration = input.actions.build === true || input.actions.fix === true;
    // A continued run whose files were already written goes straight to
    // checking/publishing them; it never regenerates the project.
    const alreadyGenerated = Boolean(resumePhase && resumePhase !== "generate");
    const needsGeneration = wantsGeneration && !alreadyGenerated;
    if (alreadyGenerated) {
      note("generate", "info", `Using the ${before.length} file${before.length === 1 ? "" : "s"} already saved in the project by the earlier session.`);
      run = completeStageSafe(run, "generate");
      await emit("generate");
    } else if (!needsGeneration) {
      await skipped("generate", before.length ? "Publishing the project's existing files." : "No files to generate.");
    } else {
      await begin("generate", input.actions.fix === true ? "Agent is repairing the project files." : "Agent is writing the project files.");
      const assets = input.imageRequests?.length ? await generateImageAssets(d, user, projectId, input.imageRequests, note, emit) : [];
      const routes: AIRouteTarget[] = await getTeam();
      if (!routes.length) {
        return await abort(
          "AI_NOT_CONFIGURED",
          `${MATRIX_MODEL_LABEL} is not configured on this deployment (GROQ_API_KEY is missing), so MATRIX cannot generate project files. Nothing was changed.`,
          "generate",
        );
      }
      note("generate", "info", routes.length > 1
        ? `Model team: ${routes.map((route) => modelLabel(route.model)).join(", ")} — working on project ${projectId} at revision ${sourceRevision}.`
        : `Agent model: ${modelLabel(routes[0].model)}.`);
      const useModel = (completion: CompletedAIResponse): void => {
        run = { ...run, model: { provider: completion.target.provider, model: completion.target.model } };
      };

      // ------------------------------------------------ design specification --
      // Decide what the site should look like BEFORE any code is written. The
      // specification is derived from the user's words, varied per project,
      // refined by the model as art director, and then handed to the coding
      // model as a binding brief. For edits it describes only what changes.
      const websiteRun = !workspaceOnly && isWebsiteRequest(input.prompt, before.map((file) => file.path));
      const storedSpec = parseStoredDesignSpec(projectRecord.design_spec);
      const originalBrief = typeof projectRecord.design_brief === "string" ? projectRecord.design_brief : "";
      let revision: DesignRevision = { scopes: ["none"], restyle: false };
      let changedAspects: string[] = [];
      const fingerprintBefore = before.length ? designFingerprint(before) : null;
      if (websiteRun && input.actions.fix !== true) {
        if (!before.length) {
          designSpec = createDesignSpec(input.prompt, { seed: projectId, title: String(projectRecord.title ?? plan.title) });
          changedAspects = ["all"];
        } else {
          revision = classifyDesignRevision(input.prompt);
          if (!(revision.scopes.length === 1 && revision.scopes[0] === "none")) {
            const revised = reviseDesignSpec(storedSpec, input.prompt, { seed: `${projectId}:${sourceRevision}`, originalBrief, title: String(projectRecord.title ?? plan.title) });
            designSpec = revised.spec;
            // A project created before specifications were stored has no
            // baseline to diff against: only the requested aspects change.
            changedAspects = storedSpec ? revised.changed : revision.scopes.map((scope) => scope === "full-redesign" ? "direction, palette, typography, layout, navigation" : scope === "mobile" ? "responsive" : scope);
          } else if (storedSpec) {
            designSpec = storedSpec;
          }
        }
        const refine = designSpec && (!before.length || revision.restyle || revision.scopes.includes("navigation") || revision.scopes.includes("hero") || revision.scopes.includes("layout"));
        if (designSpec && refine) {
          note("generate", "info", `Design plan: ${designSpec.direction.name} · ${designSpec.palette.mode} · primary ${designSpec.palette.primary} · ${designSpec.typography.heading.split(",")[0].replace(/'/g, "")}.`);
          await emit("generate");
          try {
            const planned = await completeAs("design", {
              messages: [{ role: "user", content: designPlanPrompt(`${originalBrief ? `${originalBrief}\n\nRevision request: ` : ""}${input.prompt}`, designSpec, fingerprintBefore) }],
              temperature: 0.8, maxTokens: 1400, deadlineAt: Math.min(aiDeadline, Date.now() + 45_000),
              requestId: input.requestId ? `${input.requestId}-design` : undefined,
            });
            useModel(planned);
            const merged = mergeModelDesignSpec(designSpec, planned.response.content ?? "", input.prompt);
            designSpec = merged.spec;
            if (merged.applied.length) note("generate", "info", `Design refined by ${planned.target.provider} ${planned.target.model}: ${merged.applied.join(", ")}.`);
            for (const line of merged.rejected) note("generate", "info", `Design plan adjusted: ${line}.`);
          } catch (error) {
            // The deterministic specification is already complete; a failed
            // refinement must not stop the build.
            note("generate", "warn", `Design refinement skipped (${error instanceof Error ? error.message.slice(0, 80) : "provider error"}); using the planned specification.`);
          }
        }
        if (designSpec) {
          run = { ...run, design: { direction: designSpec.direction.name, mode: designSpec.palette.mode, primary: designSpec.palette.primary, background: designSpec.palette.background, heading: designSpec.typography.heading.split(",")[0].replace(/'/g, ""), source: designSpec.source, changed: before.length ? changedAspects : [] } };
          await emit("generate");
        }
      }
      const isEdit = before.length > 0;
      const designBrief = designSpec && (!isEdit || changedAspects.length)
        ? formatDesignSpecForPrompt(designSpec, { edit: isEdit, changed: changedAspects })
        : "";
      const editInstruction = !isEdit ? "" : revision.scopes.includes("full-redesign")
        ? `REDESIGN of the existing project. Existing files: ${before.map((file) => file.path).join(", ")}. Rebuild the look of the site to the DESIGN SPECIFICATION: new layout, palette, typography and navigation, visibly different from the current design. KEEP the site's real content, brand, pages, links, forms and working JavaScript behaviour. Return every file you change, complete (normally every HTML page and the stylesheet). Keep the same file names so existing links and the deployment keep working.`
        : changedAspects.length
          ? `DESIGN REVISION of the existing project. Existing files: ${before.map((file) => file.path).join(", ")}. Change these aspects, everywhere they are defined, so the difference is clearly visible: ${changedAspects.join(", ")}. Leave the rest of the design, the content and the behaviour as they are. Return ONLY the files you change, complete.`
          : `EDIT of the existing project. Existing files: ${before.map((file) => file.path).join(", ")}. Make exactly the requested change in the real files shown. Return ONLY the files you change, complete; do not recreate or restyle unrelated files.`;
      const messages: AIMessage[] = [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        {
          role: "system",
          content: workspaceOnly
            ? [
                "MATRIX Code workspace: return complete, requested source files using the appropriate language and safe relative paths. Do not force index.html unless the user asked for a website or web page.",
                `Project title: ${String(projectRecord.title ?? plan.title)}.`,
                before.length ? `Existing project files: ${before.map((file) => file.path).join(", ")}. Preserve the existing stack and conventions; return every changed file in full and avoid unrelated rewrites.` : "This is a new project. Choose sensible filenames and a minimal, conventional structure for the requested language or framework.",
                input.attachments?.length
                  ? `The user attached these files as the source of truth: ${input.attachments.map((item) => item.path).join(", ")}. Keep their behaviour; do not invent contents for them.`
                  : "",
                "Return complete files with the MATRIX_FILE protocol. Do not claim commands, tests, builds, or previews were run. Never include secrets or unsafe paths.",
              ].filter(Boolean).join("\n")
            : [
                "MATRIX build pipeline: emit complete, publishable files only.",
                `Project title: ${String(projectRecord.title ?? plan.title)}. ${isEdit ? "The entry page stays index.html at the project root." : "Entry page must be index.html at the project root."}`,
                isEdit ? editInstruction : "CREATE MODE. This is a new project: design it for this brief from scratch.",
                isEdit ? "Never return a file whose content is identical to the saved file, and never say a file changed unless you return its new content. The pipeline compares your files with the saved ones and reports only real differences." : "",
                input.attachments?.length
                  ? `The user attached these files as the source of truth: ${input.attachments.map((item) => item.path).join(", ")}. Keep their behaviour; do not invent contents for them.`
                  : "",
                assets.length
                  ? `Generated image assets already exist in the project and MUST be referenced with relative paths: ${assets.map((asset) => `${asset.path} (${asset.width}x${asset.height})`).join(", ")}.`
                  : "Do not reference local binary images that do not exist. Use inline SVG, CSS, or real remote photos as the specification describes.",
                "Static hosting only: HTML, CSS and browser JavaScript. Nothing may need npm install, a bundler or server code. CDN-loaded libraries (including the Tailwind Play CDN) are allowed.",
              ].filter(Boolean).join("\n"),
        },
        ...(designBrief ? [{ role: "system" as const, content: designBrief }] : []),
        ...(existingProjectContext ? [{ role: "user" as const, content: existingProjectContext }] : []),
        {
          role: "user",
          content: [
            input.prompt || "Build the project described above.",
            ...(input.attachments ?? []).slice(0, 8).map((item) => `\n\nUser attachment stored as ${item.path}; use its complete source from the preceding project context only if it was included there.`),
          ].join(""),
        },
      ];
      // Creative work needs variety: at 0.2 every model returned its single
      // most-probable page. Precise edits and repairs stay low.
      const generationTemperature = workspaceOnly || input.actions.fix === true ? 0.2 : !isEdit ? 0.75 : changedAspects.length ? 0.6 : 0.2;
      let raw = "";
      let calls: NonNullable<Awaited<ReturnType<typeof completeWithModel>>["response"]["toolCalls"]> = [];
      try {
        const completion = await completeAs("implement", { messages, temperature: generationTemperature, maxTokens: 16384, aggregateStream: true, deadlineAt: aiDeadline, requestId: input.requestId ?? undefined });
        useModel(completion);
        raw = completion.response.content ?? "";
        calls = completion.response.toolCalls ?? [];
      } catch (error) {
        const detail = error instanceof Error ? error.message : "provider error";
        const failure = providerOutage(error);
        if (failure.outage) {
          // Nothing was written, nothing is lost: keep the request and carry
          // on in the next session instead of failing it.
          const timedOut = Date.now() >= aiDeadline - 5_000;
          return await pause(timedOut ? "time_limit" : "provider_unavailable",
            timedOut ? "This session's time ran out while the files were being written. The request is saved and continues automatically."
              : `The AI provider is not available right now (${detail.slice(0, 140)}). The request is saved and continues automatically when a model is available.`,
            failure.retryAt, [], "generate");
        }
        return await abort("AI_PROVIDER_FAILED", `${routes.length > 1 ? "None of the enabled models" : modelLabel(routes[0].model)} could produce the files: ${detail.slice(0, 200)}. No files were written and the project is unchanged — retry when the provider is available.`, "generate");
      }
      if (agentGenerationIncomplete(raw)) {
        note("generate", "warn", "The provider response ended mid-file; requesting one completion before saving.");
        await emit("generate");
        try {
          const continuation = await completeAs("implement", {
            messages: [
              ...messages,
              { role: "assistant", content: raw },
              { role: "user", content: "Your previous response was cut off. Return complete MATRIX_FILE block(s) for the requested project. Do not claim completion until every file is closed with <<<END_MATRIX_FILE>>> and do not repeat file content already provided." },
            ],
            temperature: 0.1,
            maxTokens: 16384,
            aggregateStream: true,
            deadlineAt: aiDeadline,
            requestId: input.requestId ? `${input.requestId}-continue` : undefined,
          });
          useModel(continuation);
          const continued = continuation.response.content ?? "";
          const continuedFiles = classifyAgentOutput(continued, continuation.response.toolCalls ?? []).files;
          raw = continuedFiles.length ? continued : `${raw}\n${continued}`;
          calls = continuation.response.toolCalls ?? calls;
        } catch (error) {
          note("generate", "warn", `Completion retry failed (${error instanceof Error ? error.message.slice(0, 80) : "provider error"}).`);
          await emit("generate");
        }
      }
      let parsed = classifyAgentOutput(raw, calls);
      if (parsed.state === "CLARIFICATION_REQUIRED") {
        reply = parsed.reply;
        executionState = transitionAgentExecution(executionState, "ask");
        run = { ...run, status: "awaiting_input", stages: run.stages.map((stage) => stage.state === "running" || stage.state === "queued" ? { ...stage, state: "skipped", finishedAt: now() } : stage), updatedAt: now(), finishedAt: now() };
        note("generate", "info", "The provider asked for input; no project files were generated, validated or published.");
        await emit("generate");
        return done(run);
      }
      if (!parsed.files.length && !agentGenerationIncomplete(raw)) {
        // The provider may have ignored the generation contract. Try one
        // explicit correction (with the available provider fallback chain)
        // rather than treating a text explanation as generated source.
        note("generate", "warn", "No file operations returned; requesting complete files once more.");
        await emit("generate");
        try {
          const retry = await completeAs("implement", {
            messages: [...messages, { role: "assistant", content: raw }, { role: "user", content: "The task is ready for implementation. Return actual complete project files (MATRIX_FILE blocks or filename-tagged code fences), not a summary of the work. If an essential detail is missing, ask one specific question instead." }],
            temperature: 0.1, maxTokens: 16384, aggregateStream: true, deadlineAt: aiDeadline, requestId: input.requestId ? `${input.requestId}-files` : undefined,
          });
          useModel(retry);
          const candidate = classifyAgentOutput(retry.response.content ?? "", retry.response.toolCalls ?? []);
          if (candidate.files.length || candidate.state === "CLARIFICATION_REQUIRED") parsed = candidate;
        } catch (error) {
          note("generate", "warn", `File retry failed (${error instanceof Error ? error.message.slice(0, 80) : "provider error"}).`);
          await emit("generate");
        }
        if (parsed.state === "CLARIFICATION_REQUIRED") {
          reply = parsed.reply;
          executionState = transitionAgentExecution(executionState, "ask");
          run = { ...run, status: "awaiting_input", stages: run.stages.map((stage) => stage.state === "running" || stage.state === "queued" ? { ...stage, state: "skipped", finishedAt: now() } : stage), updatedAt: now(), finishedAt: now() };
          await emit("generate");
          return done(run);
        }
      }
      reply = parsed.reply;
      if (!parsed.files.length) {
        const incomplete = agentGenerationIncomplete(raw);
        return await abort(
          incomplete ? "AI_OUTPUT_INCOMPLETE" : "AI_NO_FILES",
          incomplete
            ? "The coding provider stopped mid-file. No partial file was saved; retry or choose a model with a larger output limit."
            : "The coding provider returned no usable file operations after a file-generation retry. No files were written; choose a coding model or retry with a more specific description.",
          "generate",
        );
      }
      const sensitiveOutput = parsed.files.find((file) => shouldWithholdProjectFile(file.path, file.content, "utf8"));
      if (sensitiveOutput) {
        return await abort("AI_OUTPUT_SENSITIVE_FILE", "The generated output included a secret-bearing or sensitive file. MATRIX saved none of the generated files; move secrets to server-side configuration and retry.", "generate");
      }
      const withheldOverwrite = parsed.files.find((file) => withheldExistingPaths.has(file.path.toLowerCase()));
      if (withheldOverwrite) {
        return await abort("AI_OUTPUT_WITHHELD_FILE", "The requested change targets an existing file withheld from the provider for safety or size. MATRIX saved no generated files; attach a safe, complete copy or remove the secret from that file first.", "generate");
      }
      // ---------------------------------------------- real-change check --
      // An edit is only an edit if saved content differs. Files returned
      // byte-identical are dropped, and a design revision must touch the
      // files that define the design — otherwise nothing is reported as done.
      const savedByPath = new Map(before.map((file) => [file.path, file.content]));
      const realChanges = (candidate: typeof parsed.files) => candidate.filter((file) => !savedByPath.has(file.path) || !sameContent(savedByPath.get(file.path) ?? "", file.content));
      const designTouched = (candidate: typeof parsed.files) => candidate.some((file) => /\.(?:html?|css|jsx?|tsx?|vue|svelte)$/i.test(file.path));
      let effective = isEdit ? realChanges(parsed.files) : parsed.files;
      const wantsDesignChange = isEdit && changedAspects.length > 0 && changedAspects.some((aspect) => aspect !== "pages");
      if (isEdit && (!effective.length || (wantsDesignChange && !designTouched(effective)))) {
        note("generate", "warn", effective.length ? "The returned files do not change the site's design; requesting the actual design change once more." : "The returned files are identical to the saved project; requesting the actual change once more.");
        await emit("generate");
        try {
          const retry = await completeAs("implement", {
            messages: [...messages, { role: "assistant", content: raw.slice(0, 6000) }, { role: "user", content: `Your files did not change the saved project${wantsDesignChange ? "'s design" : ""}. Apply the request to the real files now: "${input.prompt.slice(0, 600)}". Return the complete new content of every file that must change${wantsDesignChange ? " (the HTML pages and stylesheet that define the look)" : ""} as MATRIX_FILE blocks. The result must differ from the saved content.` }],
            temperature: Math.max(0.5, generationTemperature), maxTokens: 16384, aggregateStream: true, deadlineAt: aiDeadline,
            requestId: input.requestId ? `${input.requestId}-change` : undefined,
          });
          useModel(retry);
          const candidate = classifyAgentOutput(retry.response.content ?? "", retry.response.toolCalls ?? []);
          const candidateChanges = realChanges(candidate.files);
          if (candidateChanges.length && (!wantsDesignChange || designTouched(candidateChanges))) {
            parsed = candidate;
            reply = candidate.reply || reply;
            effective = candidateChanges;
          }
        } catch (error) {
          note("generate", "warn", `Change retry failed (${error instanceof Error ? error.message.slice(0, 80) : "provider error"}).`);
        }
      }
      if (isEdit && !effective.length) {
        reply = "";
        return await abort("NO_CHANGES_MADE", "The model returned files identical to the saved project, so nothing was changed and no change is reported. Describe the change more specifically and try again.", "generate");
      }
      if (wantsDesignChange && !designTouched(effective)) {
        reply = "";
        return await abort("DESIGN_UNCHANGED", "The requested design change was not produced: none of the returned files alter the pages or styles. The project was left exactly as it was.", "generate");
      }
      const applied = await applyProjectFiles(d, user, {
        project_id: projectId,
        files: effective as ProjectFile[],
        expected_revision: sourceRevision,
        source: "agent",
        title: before.length ? undefined : plan.title.slice(0, 80),
      });
      executionState = transitionAgentExecution(executionState, "files_saved");
      sourceRevision = applied.revision;
      files = await loadProjectFiles(d, projectId);
      // From here on a later session must never regenerate: the files exist.
      phase = "repair";
      await saveProgress();
      if (input.conversationId && !input.isTemporary) await bindConversationProject(d, user, input.conversationId, projectId);
      const changes = summarizeChanges(before, files);
      run = setChanges(run, changes, files.length, now());
      if (designSpec && (!isEdit || changedAspects.length)) {
        // The specification is part of the project, so later revisions start
        // from what was actually built. Same document, same project ID.
        try {
          await d.collection("projects").doc(projectId).set({
            design_spec: serializeDesignSpec(designSpec),
            ...(originalBrief ? {} : { design_brief: input.prompt.slice(0, 2000) }),
          }, { merge: true });
        } catch { /* the files are saved; the stored brief is an optimisation */ }
      }
      if (wantsDesignChange && fingerprintBefore) {
        const after = designFingerprint(files);
        const coloursChanged = after.colors.slice(0, 5).join() !== fingerprintBefore.colors.slice(0, 5).join();
        const fontsChanged = after.fonts.join() !== fingerprintBefore.fonts.join();
        note("generate", "info", `Design diff — colours ${coloursChanged ? "changed" : "unchanged"}, fonts ${fontsChanged ? "changed" : "unchanged"}, ${changes.filter((change) => change.kind === "modified").length} file(s) modified, ${changes.filter((change) => change.kind === "created").length} created.`);
      }
      // What the user is told changed comes from the stored diff, not from
      // the model's own account of its work.
      const changedList = changes.slice(0, 8).map((change) => `${change.path} (${change.kind})`).join(", ");
      const modelLine = run.model ? `Model: ${run.model.provider} ${run.model.model}.` : "";
      reply = [reply.trim(), `Files changed: ${changedList || "none"}${changes.length > 8 ? ` +${changes.length - 8} more` : ""}. ${modelLine}`.trim()].filter(Boolean).join("\n\n");
      await finish("generate", `Wrote ${applied.count} file${applied.count === 1 ? "" : "s"} · ${files.length} in the project${run.model ? ` · ${run.model.provider} ${run.model.model}` : ""}.`);
    }

    if (!files.length) return await abort("NO_FILES", `Project ${projectId} has no files to build (0 files). Generate or upload source files before building.`, "build");

    if (workspaceOnly) {
      // File-writing is a real project operation, but is not a claim that the
      // source can be built or previewed by this static-hosting pipeline.
      for (const stage of ["install", "build", "validate", "publish"] as BuildStageId[]) {
        await skipped(stage, "Not run for Code-mode file generation; no build or deployment was requested.");
      }
      run = { ...run, fileCount: files.length };
      run = succeedRun(run, now());
      reply = `Wrote ${files.length} project file${files.length === 1 ? "" : "s"} to the workspace. Review the files there; ${nonStatic ? "this language needs an isolated runtime to execute or deploy" : "build checks and deployment were not run"}.`;
      await emit();
      return done(run);
    }

    // ------------------------------------------- dependencies/build/validate --
    await begin("install", "Checking declared dependencies.");
    const specForChecks = designSpec ?? parseStoredDesignSpec(projectRecord.design_spec);
    const buildProject = async (candidate: ProjectFile[]) => {
      const result = await provider.build(projectId, candidate);
      return { ...result, report: withDesignQuality(result.report, candidate, specForChecks) };
    };
    let built = await buildProject(files);
    const dependencyCheck = built.report.checks.find((check) => check.id === "dependencies");
    if (dependencyCheck?.status === "failed") {
      run = failStage(run, "install", now(), dependencyCheck.message);
      note("install", "error", dependencyCheck.message);
    } else if (dependencyCheck?.status === "skipped") {
      run = skipStage(run, "install", now(), dependencyCheck.message);
      note("install", "info", dependencyCheck.message);
    } else {
      run = completeStage(run, "install", now(), dependencyCheck?.message ?? "Dependencies resolved.");
      note("install", "success", dependencyCheck?.message ?? "Dependencies resolved.");
    }
    await emit("install");

    await begin("build", "Bundling files for static hosting.");
    if (built.bundle.ran && built.bundle.ok) {
      await finish("build", typeof built.bundle.outFileCount === "number" ? `Built ${built.bundle.outFileCount} publishable file${built.bundle.outFileCount === 1 ? "" : "s"}.` : "Build completed.");
    } else if (!built.bundle.ran) {
      run = skipStage(run, "build", now(), built.bundle.reason);
      note("build", "info", built.bundle.reason);
      await emit("build");
    } else {
      run = failStage(run, "build", now(), built.bundle.error ?? "The bundler could not build this project.");
      note("build", "error", built.bundle.error ?? "The bundler could not build this project.");
      await emit("build");
    }

    await begin("validate", "Running build checks.");
    run = setValidation(run, built.report.checks, now());
    await emit("validate");

    // ------------------------------------------------- self-healing repair --
    // Every problem the validators found is worked on until the project passes
    // or a blocker is clearly identified:
    //   1. deterministic repairs from the parsers (unclosed tags, unterminated
    //      scripts, stray code fences) — no model involved;
    //   2. model repairs that receive the exact errors and only the files that
    //      have them. Each proposal is validated in memory first and is saved
    //      only when it leaves fewer errors, so a bad repair can never replace
    //      working files.
    // Accepted changes are saved (revision-checked) straight away, so progress
    // survives a time limit, a provider outage or a restart.
    const priorChanges = resumed ? run.changes : [];
    const allChanges = () => {
      const fresh = summarizeChanges(before, files);
      const seenPaths = new Set(fresh.map((change) => change.path));
      return [...priorChanges.filter((change) => !seenPaths.has(change.path)), ...fresh];
    };
    const canRepair = input.actions.build === true || input.actions.fix === true || input.actions.publish === true;
    let repairStop: ReturnType<typeof repairStopCopy> = "";
    let repairRetryAt: number | null = null;
    let repairPaused: "time_limit" | "provider_unavailable" | null = null;
    if (canRepair && (built.report.blocking || deployVerdict(built.report).repairable.length)) {
      const hasTeam = (await getTeam()).length > 0;
      const model: RepairModel = async (request) => {
        const context = request.targets.map((file) => `<<<FILE ${file.path}>>>\n${file.content}\n<<<END FILE>>>`).join("\n\n");
        const fix = await completeAs("repair", {
          messages: [
            { role: "system", content: AGENT_SYSTEM_PROMPT },
            { role: "user", content: `Files that need repair (complete current source):\n\n${context}${request.otherPaths.length ? `\n\nOther files in the project (unchanged, do not return them): ${request.otherPaths.slice(0, 80).join(", ")}` : ""}` },
            { role: "user", content: `${request.instruction}\n\nOriginal request, for intent only: "${input.prompt.slice(0, 500)}"` },
          ],
          temperature: 0.1, maxTokens: 16384, aggregateStream: true, deadlineAt: aiDeadline + 20_000,
          requestId: input.requestId ? `${input.requestId}-repair-${request.attempt}` : undefined,
        });
        if (!run.model) run = { ...run, model: { provider: fix.target.provider, model: fix.target.model } };
        return parseAgentResponse(fix.response.content ?? "", { allowUnlabelledFences: true, allowRawHtmlDocument: request.targets.length === 1 }).files;
      };
      let checkpointed = false;
      let lastProviderError: unknown = null;
      const guardedModel: RepairModel = async (request) => {
        try { return await model(request); }
        catch (error) { lastProviderError = error; throw error; }
      };
      // Each execution session gets the configured number of attempts; the
      // session cap (MAX_RUN_SEGMENTS) bounds the total.
      const attemptsLeft = run.maxAttempts;
      const outcome = await runRepairLoop({
        files,
        evaluate: async (candidate) => (await buildProject(candidate)).report,
        model: hasTeam ? guardedModel : null,
        maxAttempts: attemptsLeft,
        deadlineAt: aiDeadline,
        withhold: (path, content) => shouldWithholdProjectFile(path, content, "utf8") || withheldExistingPaths.has(path.toLowerCase()),
        onAttempt: async (attempt, issues) => {
          run = bumpAttempt(run, now());
          run = { ...run, stages: run.stages.map((stage) => (stage.id === "validate" ? { ...stage, state: "running", message: `Fixing ${issues.length} problem${issues.length === 1 ? "" : "s"} (attempt ${attempt}).` } : stage)) };
          note("validate", "warn", `Fixing issue… attempt ${attempt}: ${issues.slice(0, 3).map((issue) => `${issue.path}${issue.line ? `:${issue.line}` : ""} ${issue.message}`).join("; ").slice(0, 300)}`);
          await emit("validate");
        },
        onAccept: async (changed, _record, state) => {
          if (!checkpointed) {
            // Restore point before the first repair touches the saved files.
            checkpointed = true;
            try { await saveProjectVersion(d, user, { project_id: projectId, source: "agent", summary: "Before automatic repair" }); }
            catch { note("validate", "warn", "A restore point could not be saved before the repair; continuing because the repair was verified to reduce errors."); }
          }
          const saved = await applyProjectFiles(d, user, { project_id: projectId, files: changed, source: "agent", expected_revision: sourceRevision });
          sourceRevision = saved.revision;
          files = state.files;
          run = setChanges(run, allChanges(), files.length, now());
          run = setValidation(run, withDesignQuality(state.report, files, specForChecks).checks, now());
        },
        onProgress: async (record) => {
          run = { ...run, repairs: [...(run.repairs ?? []), record].slice(-24) };
          const level = record.outcome === "accepted" || record.outcome === "partly_accepted" ? "success" : record.outcome === "provider_error" ? "warn" : "info";
          const label = record.kind === "deterministic" ? "Automatic repair" : `Repair attempt ${record.attempt}`;
          note("validate", level, `${label}: ${record.outcome.replace(/_/g, " ")} — ${record.errorsBefore} → ${record.errorsAfter} problem${record.errorsAfter === 1 ? "" : "s"}. ${record.detail}`.slice(0, 380));
          await emit("validate");
        },
      });
      // Storage is authoritative: rebuild from what was actually saved.
      files = await loadProjectFiles(d, projectId);
      built = await buildProject(files);
      run = setChanges(run, allChanges(), files.length, now());
      run = setValidation(run, built.report.checks, now());
      if (outcome.history.some((item) => item.outcome === "accepted" || item.outcome === "partly_accepted")) {
        note("validate", "success", deployVerdict(built.report).repairable.length ? "Repair applied; some problems remain." : "Repair completed.");
        if (input.conversationId && !input.isTemporary) await bindConversationProject(d, user, input.conversationId, projectId);
      }
      await emit("validate");
      if (outcome.stop !== "clean") {
        repairStop = repairStopCopy(outcome.stop);
        if (outcome.stop === "deadline") repairPaused = "time_limit";
        if (outcome.stop === "provider") {
          const failure = providerOutage(lastProviderError);
          if (failure.outage) { repairPaused = "provider_unavailable"; repairRetryAt = failure.retryAt; }
        }
      }
    }
    const describe = (issue: ClassifiedIssue): string => `${issue.path}${issue.line ? `:${issue.line}` : ""} — ${issue.message}`;

    // ------------------------------------------------ design polish pass --
    // A build can pass while the page is still poor on a phone. When this run
    // generated the files and the design review found significant problems,
    // ask for ONE targeted correction, test the result in memory, and keep it
    // only if it is strictly better. Never loops, never blocks publishing.
    const designCheck = built.report.checks.find((check) => check.id === "design");
    const designProblems = designCheck ? significantDesignIssues(designCheck) : [];
    if (!built.report.blocking && wantsGeneration && designProblems.length && Date.now() < aiDeadline - 60_000) {
      note("validate", "info", `Design review found ${designProblems.length} issue${designProblems.length === 1 ? "" : "s"}; requesting one improvement pass.`);
      await emit("validate");
      try {
        const routes = await getTeam();
        const polish = routes.length ? await completeAs("review", {
          messages: [
            { role: "system", content: AGENT_SYSTEM_PROMPT },
            { role: "user", content: sourceContext(files, "") },
            { role: "user", content: `A design review of this project found the problems below. Fix them in the real files and return ONLY the files you change, complete, as MATRIX_FILE blocks. Keep the existing design, content and behaviour otherwise.\n\n${formatIssues(designProblems, 10)}` },
          ],
          temperature: 0.2, maxTokens: 16384, aggregateStream: true, deadlineAt: aiDeadline, requestId: input.requestId ? `${input.requestId}-polish` : undefined,
        }) : null;
        const polished = polish ? parseAgentResponse(polish.response.content ?? "", { allowUnlabelledFences: true, allowRawHtmlDocument: true }).files : [];
        const safe = polished.filter((file) => !shouldWithholdProjectFile(file.path, file.content, "utf8") && files.some((existing) => existing.path === file.path));
        if (safe.length) {
          const byPath = new Map(safe.map((file) => [file.path, file.content]));
          const candidate = files.map((file) => byPath.has(file.path) ? { ...file, content: byPath.get(file.path) as string } : file);
          const trial = await buildProject(candidate);
          const trialCheck = trial.report.checks.find((check) => check.id === "design");
          const remaining = trialCheck ? significantDesignIssues(trialCheck).length : 0;
          if (!trial.report.blocking && remaining < designProblems.length) {
            const polishResult = await applyProjectFiles(d, user, { project_id: projectId, files: safe as ProjectFile[], source: "agent", expected_revision: sourceRevision });
            sourceRevision = polishResult.revision;
            files = await loadProjectFiles(d, projectId);
            built = await buildProject(files);
            run = setChanges(run, summarizeChanges(before, files), files.length, now());
            run = setValidation(run, built.report.checks, now());
            note("validate", "success", `Design improvements applied: ${designProblems.length - remaining} of ${designProblems.length} issue${designProblems.length === 1 ? "" : "s"} resolved.`);
          } else {
            note("validate", "info", "The improvement pass did not make the design measurably better, so the files were left unchanged.");
          }
          await emit("validate");
        }
      } catch (error) {
        note("validate", "info", `Design improvement pass skipped (${error instanceof Error ? error.message.slice(0, 80) : "provider error"}).`);
      }
    }

    // --------------------------------------------------------- verdict --
    // Three classes decide what happens next (see lib/deploy/classify.ts):
    //   blocking   — stops the deployment (broken entry page, fatal build
    //                failure, a page that cannot work);
    //   repairable — was sent through the repair loop; whatever could not be
    //                fixed AND does not break the site is published and
    //                reported as a known issue;
    //   warning    — never stops a deployment.
    const verdict = deployVerdict(built.report);
    const unresolved = [...verdict.blockers, ...verdict.knownIssues].map(describe);
    run = { ...run, knownIssues: verdict.deployable ? verdict.knownIssues.length : 0 };
    if (!verdict.deployable) {
      const summary = (verdict.blockers.length ? verdict.blockers.map(describe) : blockingIssues(built.report).map((issue) => `${issue.path}${issue.line ? `:${issue.line}` : ""} — ${issue.message}`)).slice(0, 3).join(" ");
      if (repairPaused && !input.allowOverride) {
        // Not a failure: the repair simply ran out of this session's time or
        // the provider went away. Everything fixed so far is saved.
        return await pause(repairPaused,
          repairPaused === "time_limit"
            ? `This session's time ran out with ${verdict.blockers.length || built.report.errors} problem${(verdict.blockers.length || built.report.errors) === 1 ? "" : "s"} still being repaired. Progress is saved and the repair continues automatically.`
            : "The AI provider became unavailable during the repair. Progress is saved and the repair continues automatically when a model is available.",
          repairRetryAt, unresolved, "validate");
      }
      if (!input.allowOverride) {
        // Keep the request resumable: "Continue fixing" picks up at the repair
        // with the files as they are now.
        await saveProgress(unresolved);
        const why = repairStop ? ` Automatic repair stopped because ${repairStop}.` : "";
        return await abort("BUILD_FAILED", `Build failed: ${summary || built.report.summary}${why}`.slice(0, 480), "validate");
      }
      note("validate", "warn", "Publishing anyway: you chose to publish with failing checks.");
      run = completeStage(run, "validate", now(), `Published with ${built.report.errors} unresolved problem(s), at your request.`);
      await emit("validate");
    } else if (verdict.knownIssues.length) {
      const count = verdict.knownIssues.length;
      note("validate", "warn", `${count} non-critical problem${count === 1 ? "" : "s"} could not be repaired automatically${repairStop ? ` (${repairStop})` : ""}: ${verdict.knownIssues.slice(0, 4).map(describe).join("; ")}`.slice(0, 380));
      await finish("validate", `Build verified with ${count} known issue${count === 1 ? "" : "s"} that ${count === 1 ? "does" : "do"} not stop the site from working.`);
      reply = [reply.trim(), `Known issue${count === 1 ? "" : "s"} left in the project (the site works, but ${count === 1 ? "this needs" : "these need"} attention):\n${verdict.knownIssues.slice(0, 6).map((issue) => `- ${describe(issue)}`).join("\n")}`].filter(Boolean).join("\n\n");
    } else {
      await finish("validate", built.report.blocking ? "Build verified." : built.report.summary);
    }

    if (verdict.deployable) {
      await d.collection("projects").doc(projectId).set({ last_successful_build_at: nowTs(), updated_at: nowTs() }, { merge: true });
    }
    phase = "publish";

    // ------------------------------------------------------------- preview ---
    const previewUrl = `/api/projects/${projectId}/preview`;
    if (input.actions.preview && !input.actions.publish) {
      await skipped("publish", "Preview build ready — nothing was published.");
      run = succeedRun(setPreviewUrl(run, previewUrl, now()), now());
      note("publish", "info", `Preview available at ${previewUrl}`);
      await emit("publish");
      return done(run);
    }

    // ------------------------------------------------------------- publish ---
    if (!input.actions.publish) {
      await skipped("publish", "Publish was not requested — the build is ready to preview.");
      run = succeedRun(setPreviewUrl(run, previewUrl, now()), now());
      await emit("publish");
      return done(run);
    }

    await begin("publish", "Publishing to MATRIX hosting.");
    try {
      const deployment = await provider.deploy({
        projectId,
        runId,
        slug: input.slug?.trim() ? slug : null,
        environment: run.environment,
        report: built.report,
        overridden: input.allowOverride === true && !verdict.deployable,
        onLog: (entry) => note("publish", entry.step === "error" ? "error" : "info", `${entry.step}: ${entry.detail}`),
      });
      run = setDeployment(run, {
        id: deployment.id,
        status: deployment.status,
        url: deployment.url,
        slug: deployment.slug,
        environment: (deployment.environment === "preview" ? "preview" : "production") as BuildEnvironment,
        rollbackAvailable: deployment.rollbackAvailable,
        overridden: deployment.overridden,
        error: deployment.error,
      }, now());
      if (deployment.status !== "live" || !deployment.url) {
        return await abort("DEPLOY_INCOMPLETE", "The hosting provider did not report a live deployment, so no link is shown.", "publish");
      }
      await finish("publish", `Published at ${deployment.url}`);
      if (input.conversationId && !input.isTemporary) await bindConversationProject(d, user, input.conversationId, projectId);
      run = { ...run, fileCount: deployment.files || files.length };
      for (const stage of ["generate", "install", "build", "validate"] as BuildStageId[]) {
        run = completeStageSafe(run, stage);
      }
      run = setPreviewUrl(run, previewUrl, now());
      run = succeedRun(run, now());
      if (run.status !== "succeeded") {
        return await abort("BUILD_INCOMPLETE", "MATRIX could not mark every build step complete, so this deployment is not reported as successful.", "publish");
      }
      await emit("publish");
      return done(run);
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "DEPLOY_FAILED";
      const message = publishFailureCopy(code, error);
      // The build is verified and saved; only the publish step is left. Keep
      // that on record so Retry publishes again without rebuilding anything.
      if (!["SLUG_TAKEN", "SLUG_INVALID", "NO_FILES", "INDEX_REQUIRED", "BUILD_FAILED"].includes(code)) await saveProgress([message]);
      return await abort(code, message, "publish");
    }
  } catch (error) {
    const code = error instanceof RpcError ? error.code : run.stages.find((stage) => stage.id === "plan")?.state === "running" ? "PROJECT_STORAGE_UNAVAILABLE" : "BUILD_RUN_FAILED";
    if (code === "CANCELLED") {
      executionState = transitionAgentExecution(executionState, "cancel");
      run = cancelRun(run, now());
      note(null, "warn", "Build cancelled by the user.");
      await emit();
      return done(run);
    }
    const detail = error instanceof RpcError ? error.detail : undefined;
    const activeStage = run.stages.find((stage) => stage.state === "running");
    return await abort(code, detail || (code === "PROJECT_STORAGE_UNAVAILABLE" ? "Project storage could not be reached. No files were changed; retry after checking Firestore connectivity." : error instanceof Error ? error.message.slice(0, 240) : "The build stopped unexpectedly."), activeStage?.id);
  } finally {
    const messageId = await persistBuildMessage(d, user, input, run, reply, run.status === "succeeded" ? transitionAgentExecution(executionState, "complete") : executionState, resumed?.state.messageId ?? null);
    try {
      if (run.status === "succeeded" || run.status === "cancelled" || run.status === "awaiting_input") {
        if (progressSaved || resumed) await clearResumeState(d, runId);
      } else if (messageId && (progressSaved || resumed)) {
        // The chat shows ONE message for this run; later sessions update it.
        await d.collection("build_runs").doc(runId).set({ resume_message_id: messageId }, { merge: true });
      }
    } catch { /* the run document already holds the outcome */ }
  }
}

/**
 * One assistant message per build run, so the chat history and the deployment
 * record stay in sync after a reload. Persisted by the server (the client only
 * mirrors it locally) and stamped with the real run snapshot.
 */
async function persistBuildMessage(
  d: Db,
  user: SessionUser,
  input: BuildPipelineInput,
  run: BuildRun,
  reply: string,
  executionState: AgentExecutionState,
  existingMessageId: string | null = null,
): Promise<string | null> {
  if (!input.conversationId || input.isTemporary) return null;
  const summary = buildRunCopy(run);
  const body =
    reply.trim() ||
    (run.status === "cancelled"
      ? "Build cancelled. No success was reported."
      : run.status === "paused"
      ? `${run.continuation?.message ?? "This request is paused and will continue."}`
      : run.status === "failed"
      ? `MATRIX stopped during ${summary.detail.toLowerCase()} — nothing else was changed.`
      : `Build finished. ${run.fileCount} project file${run.fileCount === 1 ? "" : "s"} ready.`);
  const text = summary.canOpenLive
    ? `${body}\n\nLive: ${run.deployment?.url ?? ""}`.trim()
    : body;
  try {
    const messages = d.collection("conversations").doc(input.conversationId).collection("messages");
    const payload = {
      role: "assistant",
      content: text,
      metadata: {
        mode: input.chatMode ?? "agent",
        execution_state: executionState,
        project_id: run.projectId,
        ...(run.model ? { model: run.model.model, provider: run.model.provider } : {}),
        ...(run.status === "awaiting_input" ? { agent_task: {
          originalRequest: input.taskContext?.originalRequest ?? input.prompt,
          clarifications: input.taskContext?.clarifications ?? [],
          state: "CLARIFICATION_REQUIRED",
          projectId: run.projectId,
          taskId: run.taskId,
        } } : { build: toRunSnapshot(run) }),
        deployment: run.deployment
          ? {
              id: run.deployment.id,
              status: run.deployment.status,
              url: run.deployment.status === "live" ? run.deployment.url : null,
              slug: run.deployment.slug,
              environment: run.deployment.environment,
              files: run.fileCount,
            }
          : null,
      },
    };
    let messageId: string;
    if (existingMessageId) {
      // A continued run updates its one message; it never adds another.
      await messages.doc(existingMessageId).set({ ...payload, updated_at: nowTs() }, { merge: true });
      messageId = existingMessageId;
    } else {
      messageId = (await messages.add({ ...payload, created_at: nowTs() })).id;
    }
    await d.collection("conversations").doc(input.conversationId).set({ updated_at: nowTs(), mode: input.chatMode ?? "agent" }, { merge: true });
    return messageId;
  } catch {
    /* chat persistence is best-effort; the run itself is already stored */
    return null;
  }
}

/**
 * Close out the stages the pipeline completed implicitly (a successful
 * provider build already covers generate/validate). Only ever promotes
 * running or queued stages — never a failed one.
 */
function completeStageSafe(run: BuildRun, id: BuildStageId): BuildRun {
  const stage = run.stages.find((item) => item.id === id);
  if (!stage || stage.state === "completed" || stage.state === "skipped" || stage.state === "failed") return run;
  return completeStage(run, id, Date.now(), stage.message || "Completed as part of the publish step.");
}

function publishFailureCopy(code: string, error: unknown): string {
  const fallback = error instanceof Error ? error.message.slice(0, 160) : "The deployment did not complete.";
  switch (code) {
    case "BUILD_FAILED":
      return "Publishing was blocked because the build did not pass its checks. Fix the reported problems, or choose Publish anyway if you accept the risk.";
    case "SLUG_TAKEN":
      return "That public address is already taken. Choose another one and publish again.";
    case "SLUG_INVALID":
      return "The address you chose is not valid. Use 3-40 lowercase letters, numbers or dashes.";
    case "INDEX_REQUIRED":
      return "The project needs an index.html entry page before it can be published.";
    case "NO_FILES":
      return "The project has no files to publish.";
    case "PUBLISH_RATE_LIMITED":
      return "Too many publishes in the last hour. Wait a moment and retry.";
    case "DEPLOY_VERIFY_FAILED":
      return `The new release could not be verified over HTTP; the previous live version remains active. ${error instanceof RpcError ? error.detail ?? "Check deployment logs for the failed URL and response." : "Check deployment logs."}`;
    case "HOSTING_NOT_CONFIGURED":
      return "This deployment of MATRIX has no hosting backend configured, so nothing was published. Ask the operator to connect a DeploymentProvider.";
    default:
      return `Publishing failed: ${fallback}`;
  }
}

// ---------------------------------------------------------------------------
// Generated image assets (§27)
// ---------------------------------------------------------------------------

async function generateImageAssets(
  d: Db,
  user: SessionUser,
  projectId: string,
  requested: ImageAssetRequest[],
  note: (stage: BuildStageId | null, level: BuildLogLine["level"], message: string) => void,
  emit: (stage?: BuildStageId) => Promise<void>,
): Promise<Array<{ path: string; width: number; height: number; reused: boolean }>> {
  const out: Array<{ path: string; width: number; height: number; reused: boolean }> = [];
  if (!requested.length) return out;
  if (!(await isImageGenerationConfigured(d))) {
    note("generate", "warn", "Image generation is not configured — an administrator can add an image provider under Admin → AI configuration. The project will use inline SVG instead.");
    return out;
  }
  const doc = await d.collection("projects").doc(projectId).get();
  const manifest = Array.isArray(doc.data()?.image_assets) ? (doc.data()?.image_assets as Array<{ path: string; promptHash: string }>) : [];
  for (const request of requested.slice(0, MAX_IMAGE_ASSETS)) {
    const promptHash = hashPrompt(request.prompt);
    const name = request.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 40) || `asset-${out.length + 1}`;
    const path = `assets/images/${name}.png`;
    const existing = manifest.find((entry) => entry.promptHash === promptHash && entry.path === path);
    if (existing) {
      out.push({ path, width: 768, height: 768, reused: true });
      note("generate", "info", `Reusing existing generated asset ${path} (same prompt).`);
      continue;
    }
    note("generate", "info", `Generating image asset ${path}…`);
    await emit("generate");
    try {
      const image = await generateImage(d, request.prompt, { width: 768, height: 768, signal: AbortSignal.timeout(90_000) });
      const bytes = Math.floor(image.b64.length * 0.75);
      if (bytes > PROJECT_LIMITS.maxImageBytes) {
        note("generate", "warn", `Generated image for ${path} (${Math.round(bytes / 1024)} KB) exceeds the per-file asset budget — not stored.`);
        continue;
      }
      const { upsertProjectFile } = await import("@/lib/server/projects");
      await upsertProjectFile(d, user, { project_id: projectId, path, content: image.b64, encoding: "base64", source: "agent" });
      manifest.push({ path, promptHash });
      await d.collection("projects").doc(projectId).set({ image_assets: manifest.slice(-12), updated_at: nowTs() }, { merge: true });
      out.push({ path, width: 768, height: 768, reused: false });
      note("generate", "success", `Stored generated asset ${path}.`);
    } catch (error) {
      note("generate", "warn", `Image generation for ${path} failed (${error instanceof Error ? error.message.slice(0, 60) : "provider error"}) — continuing without it.`);
    }
    await emit("generate");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persist(d: Db, runId: string, run: BuildRun): Promise<void> {
  await d
    .collection("build_runs")
    .doc(runId)
    .set({ run: toFirestoreRun(run), resumable: run.status === "paused" && run.continuation?.available === true, updated_at: nowTs() }, { merge: true })
    .catch(() => { throw new RpcError("PROJECT_STORAGE_UNAVAILABLE", 503, "Build state could not be saved. No further file operations were started."); });
}

export async function startBuildRun(
  d: Db,
  user: SessionUser,
  p: {
    projectId?: string | null;
    conversationId?: string | null;
    prompt: string;
    intent?: BuildIntent;
    actions?: BuildActions;
    workspaceOnly?: boolean;
    slug?: string | null;
    allowOverride?: boolean;
    imageRequests?: ImageAssetRequest[];
    requestId?: string | null;
  },
): Promise<{ runId: string }> {
  const runId = crypto.randomBytes(10).toString("hex");
  const actions: BuildActions = p.actions ?? {
    build: p.intent?.build ?? true,
    publish: p.intent?.publish ?? false,
    preview: p.intent?.preview ?? !p.intent?.publish,
    fix: p.intent?.fix ?? false,
  };
  await d
    .collection("build_runs")
    .doc(runId)
    .set({
      owner_id: user.uid,
      project_id: p.projectId ?? null,
      conversation_id: p.conversationId ?? null,
      run: toFirestoreRun(
        createBuildRun({
          id: runId,
          projectId: p.projectId ?? null,
          conversationId: p.conversationId ?? null,
          requestId: p.requestId ?? null,
          actions,
          workspaceOnly: p.workspaceOnly === true,
          now: Date.now(),
        }),
      ),
      created_at: nowTs(),
      updated_at: nowTs(),
    })
    .catch(() => { throw new RpcError("PROJECT_STORAGE_UNAVAILABLE", 503, "Build state could not be saved. No build was started."); });
  return { runId };
}

export async function readBuildRun(d: Db, user: SessionUser, runId: string, now = Date.now()): Promise<BuildRun | null> {
  const doc = await d.collection("build_runs").doc(runId).get();
  if (!doc.exists) return null;
  const data = doc.data() ?? {};
  if (data.owner_id !== user.uid) return null;
  const run = runFromFirestore(data.run, now);
  return run ? applyStaleness(run, now) : null;
}

export async function latestBuildRunForProject(d: Db, user: SessionUser, projectId: string, now = Date.now()): Promise<BuildRun | null> {
  const snap = await d.collection("build_runs").where("project_id", "==", projectId).get();
  const mine = snap.docs
    .filter((doc) => doc.data().owner_id === user.uid)
    .sort((a, b) => String(b.data().updated_at?.toDate?.()?.toISOString?.() ?? "").localeCompare(String(a.data().updated_at?.toDate?.()?.toISOString?.() ?? "")));
  if (!mine.length) return null;
  const run = runFromFirestore(mine[0].data().run, now);
  return run ? applyStaleness(run, now) : null;
}

export { stageProgress };
