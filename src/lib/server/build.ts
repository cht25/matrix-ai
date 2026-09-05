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
import { completeWithFallback } from "@/lib/ai/executor";
import { createAIRoutesFromDb, type AIRouteTarget } from "@/lib/ai/config";
import { AGENT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { parseAgentResponse } from "@/lib/ai/agent";
import { planFromRequest, type BuildIntent } from "@/lib/ai/build-intent";
import { generateTogetherImage, isTogetherConfigured } from "@/lib/ai/together";
import { applyProjectFiles, ensureProject, loadProjectFiles } from "@/lib/server/projects";
import { PROJECT_LIMITS, type ProjectFile } from "@/lib/projects/paths";
import {
  applyStaleness, beginStage, buildRunCopy, completeStage, createBuildRun, failRun, failStage,
  setDeployment, setChanges, setPreviewUrl, setValidation, skipStage, stageProgress, succeedRun,
  summarizeChanges, bumpAttempt,
  toRunSnapshot,
  type BuildActions, type BuildEnvironment, type BuildLogLine, type BuildRun, type BuildStageId,
} from "@/lib/deploy/stages";
import { blockingIssues, buildFixPrompt, formatIssues } from "@/lib/deploy/validate";
import type { DeploymentProvider } from "@/lib/deploy/provider";
import { toFirestoreRun, runFromFirestore } from "@/lib/deploy/run-store";

export type ImageAssetRequest = { name: string; prompt: string };

export type BuildPipelineInput = {
  d: Db;
  user: SessionUser;
  provider: DeploymentProvider;
  runId: string;
  projectId?: string | null;
  conversationId?: string | null;
  requestId?: string | null;
  prompt: string;
  actions: BuildActions;
  environment?: BuildEnvironment;
  slug?: string | null;
  /** Explicit user override: publish despite failing checks (§14). */
  allowOverride?: boolean;
  imageRequests?: ImageAssetRequest[];
  maxFixAttempts?: number;
  /** Store the assistant turn in the conversation (skipped for temp chats). */
  isTemporary?: boolean;
  onEvent?: (event: { run: BuildRun; stage?: BuildStageId; copy?: ReturnType<typeof buildRunCopy> }) => void;
};

export type BuildPipelineResult = { run: BuildRun; reply: string; projectId: string | null };

const MAX_FIX_ATTEMPTS = 2;
const MAX_IMAGE_ASSETS = 4;

function hashPrompt(prompt: string): string {
  return crypto.createHash("sha1").update(prompt.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export async function runBuildPipeline(input: BuildPipelineInput): Promise<BuildPipelineResult> {
  const { d, user, provider, runId } = input;
  const now = () => Date.now();
  let reply = "";
  let resolvedProjectId: string | null = input.projectId ?? null;
  const done = (run: BuildRun): BuildPipelineResult => ({ run, reply, projectId: resolvedProjectId });
  let run = createBuildRun({
    id: runId,
    projectId: input.projectId ?? null,
    conversationId: input.conversationId ?? null,
    requestId: input.requestId ?? null,
    actions: input.actions,
    environment: input.environment ?? "production",
    maxAttempts: Math.min(input.maxFixAttempts ?? MAX_FIX_ATTEMPTS, 5),
    now: now(),
  });

  const emit = async (stage?: BuildStageId): Promise<void> => {
    await persist(d, runId, run);
    input.onEvent?.({ run, stage, copy: buildRunCopy(run) });
  };

  const note = (stage: BuildStageId | null, level: BuildLogLine["level"], message: string): void => {
    run = { ...run, logs: [...run.logs, { at: now(), stage, level, message }].slice(-160) };
  };

  const begin = async (stage: BuildStageId, message: string): Promise<void> => {
    run = beginStage(run, stage, now(), message);
    note(stage, "info", message);
    await emit(stage);
  };

  const finish = async (stage: BuildStageId, message: string): Promise<void> => {
    run = completeStage(run, stage, now(), message);
    note(stage, "success", message);
    await emit(stage);
  };

  const skipped = async (stage: BuildStageId, message: string): Promise<void> => {
    run = beginStage(run, stage, now(), message);
    run = skipStage(run, stage, now(), message);
    note(stage, "info", message);
    await emit(stage);
  };

  const abort = async (code: string, message: string, stage?: BuildStageId): Promise<BuildPipelineResult> => {
    if (stage) run = failStage(run, stage, now(), message);
    run = failRun(run, { code, message }, now());
    note(stage ?? null, "error", message);
    await emit(stage);
    return done(run);
  };

  try {
    await emit();
    // ---------------------------------------------------------------- plan --
    await begin("plan", "Resolving project, entry page and public address.");
    const plan = planFromRequest(input.prompt || "MATRIX project");
    let projectId = input.projectId ?? null;
    resolvedProjectId = projectId;
    if (!projectId && (input.actions.build || input.actions.publish)) {
      const ensured = await ensureProject(d, user, {
        conversation_id: input.conversationId ?? null,
        title: plan.title.slice(0, 80),
      });
      projectId = ensured.id;
      resolvedProjectId = projectId;
      run = { ...run, projectId };
      note("plan", "info", `Created project "${plan.title}".`);
    }
    if (!projectId) return await abort("PROJECT_REQUIRED", "There is no project to build yet. Describe what to create and I will make it.", "plan");
    const before = await loadProjectFiles(d, projectId);
    const slug = (input.slug ?? "").trim() || plan.slug;
    await finish("plan", `Project ready · ${before.length} existing file${before.length === 1 ? "" : "s"} · address /s/${slug}.`);

    // ------------------------------------------------------------ generate --
    let files = before;
    const needsGeneration = input.actions.build === true || input.actions.fix === true;
    if (!needsGeneration) {
      await skipped("generate", before.length ? "Publishing the project's existing files." : "No files to generate.");
    } else {
      await begin("generate", input.actions.fix === true ? "Agent is repairing the project files." : "Agent is writing the project files.");
      const assets = input.imageRequests?.length ? await generateImageAssets(d, user, projectId, input.imageRequests, note, emit) : [];
      let routes: AIRouteTarget[] = [];
      try {
        routes = await createAIRoutesFromDb(d, true);
      } catch {
        routes = [];
      }
      if (!routes.length) {
        return await abort(
          "AI_NOT_CONFIGURED",
          "No AI provider is configured on this deployment, so MATRIX cannot generate project files. Existing project files can still be validated and published.",
          "generate",
        );
      }
      const messages: AIMessage[] = [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        {
          role: "system",
          content: [
            "MATRIX build pipeline: emit complete, publishable files only.",
            `Project title: ${plan.title}. Entry page must be index.html at the project root.`,
            before.length ? `Existing project files: ${before.map((file) => file.path).join(", ")}. Return every file you change, complete.` : "This is a new project.",
            assets.length
              ? `Generated image assets already exist in the project and MUST be referenced with relative paths: ${assets.map((asset) => `${asset.path} (${asset.width}x${asset.height})`).join(", ")}.`
              : "Do not reference local binary images that do not exist. Use inline SVG or CSS art.",
            "Static hosting only: plain HTML, CSS and JavaScript. No bundler, no npm install, no server code.",
          ].join("\n"),
        },
        { role: "user", content: input.prompt || "Build the project described above." },
      ];
      let raw = "";
      try {
        const completion = await completeWithFallback(routes, { messages, temperature: 0.2, maxTokens: 16384, requestId: input.requestId ?? undefined });
        raw = completion.response.content ?? "";
      } catch (error) {
        const detail = error instanceof Error ? error.message : "provider error";
        return await abort("AI_PROVIDER_FAILED", `MATRIX could not reach the coding provider (${detail.slice(0, 120)}), so no files were written.`, "generate");
      }
      const parsed = parseAgentResponse(raw);
      reply = parsed.reply;
      if (!parsed.files.length) {
        return await abort("AI_NO_FILES", "The coding provider answered without any project files, so nothing was written or published.", "generate");
      }
      const applied = await applyProjectFiles(d, user, {
        project_id: projectId,
        files: parsed.files as ProjectFile[],
        source: "agent",
        title: before.length ? undefined : plan.title.slice(0, 80),
      });
      files = await loadProjectFiles(d, projectId);
      const changes = summarizeChanges(before, files);
      run = setChanges(run, changes, files.length, now());
      await finish("generate", `Wrote ${applied.count} file${applied.count === 1 ? "" : "s"} · ${files.length} in the project.`);
    }

    if (!files.length) return await abort("NO_FILES", "The project has no files to build.", "build");

    // ------------------------------------------- dependencies/build/validate --
    await begin("install", "Checking declared dependencies.");
    let built = await provider.build(projectId, files);
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

    // ----------------------------------------------------- auto-fix loop (§15) --
    let attempt = 0;
    while (built.report.blocking && attempt < run.maxAttempts && (input.actions.build || input.actions.fix)) {
      attempt += 1;
      run = bumpAttempt(run, now());
      const issueText = formatIssues(blockingIssues(built.report), 6);
      note("validate", "warn", `Build attempt ${attempt} failed — asking the Agent to fix it.`);
      await emit("validate");
      let routes: AIRouteTarget[] = [];
      try {
        routes = await createAIRoutesFromDb(d, true);
      } catch {
        routes = [];
      }
      if (!routes.length) break;
      const fixMessages: AIMessage[] = [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: buildFixPrompt(built.report, files.length) },
        { role: "assistant", content: reply || "(previous build)" },
        { role: "user", content: `Return only the corrected files. Problems:\n${issueText}` },
      ];
      try {
        const fix = await completeWithFallback(routes, { messages: fixMessages, temperature: 0.1, maxTokens: 16384, requestId: input.requestId ?? undefined });
        const fixed = parseAgentResponse(fix.response.content ?? "");
        if (fixed.files.length) {
          await applyProjectFiles(d, user, { project_id: projectId, files: fixed.files as ProjectFile[], source: "agent" });
          files = await loadProjectFiles(d, projectId);
          const changes = summarizeChanges(before, files);
          run = setChanges(run, changes, files.length, now());
          run = { ...run, stages: run.stages.map((stage) => (stage.id === "validate" ? { ...stage, state: "running", message: `Rebuilding after fix ${attempt}.` } : stage)) };
          note("validate", "info", `Applied ${fixed.files.length} corrected file${fixed.files.length === 1 ? "" : "s"} (attempt ${attempt}).`);
          await emit("validate");
        }
      } catch {
        break;
      }
      built = await provider.build(projectId, files);
      run = setValidation(run, built.report.checks, now());
      await emit("validate");
    }

    if (built.report.blocking) {
      const summary = blockingIssues(built.report)
        .slice(0, 3)
        .map((issue) => `${issue.path}${issue.line ? `:${issue.line}` : ""} — ${issue.message}`)
        .join(" ");
      if (!input.allowOverride) {
        return await abort("BUILD_FAILED", `Build failed: ${summary || built.report.summary}`.slice(0, 480), "validate");
      }
      note("validate", "warn", "Publishing anyway: you chose to publish with failing checks.");
      run = completeStage(run, "validate", now(), `Published with ${built.report.errors} unresolved problem(s), at your request.`);
      await emit("validate");
    } else {
      await finish("validate", built.report.summary);
    }

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
        overridden: input.allowOverride === true && built.report.blocking,
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
      return await abort(code, message, "publish");
    }
  } catch (error) {
    const code = error instanceof RpcError ? error.code : "BUILD_RUN_FAILED";
    return await abort(code, error instanceof Error ? error.message.slice(0, 240) : "The build stopped unexpectedly.", undefined);
  } finally {
    await persistBuildMessage(d, user, input, run, reply);
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
): Promise<void> {
  if (!input.conversationId || input.isTemporary) return;
  const summary = buildRunCopy(run);
  const body =
    reply.trim() ||
    (run.status === "failed"
      ? `MATRIX stopped during ${summary.detail.toLowerCase()} — nothing else was changed.`
      : `Build finished. ${run.fileCount} project file${run.fileCount === 1 ? "" : "s"} ready.`);
  const text = summary.canOpenLive
    ? `${body}\n\nLive: ${run.deployment?.url ?? ""}`.trim()
    : body;
  try {
    await d.collection("conversations").doc(input.conversationId).collection("messages").add({
      role: "assistant",
      content: text,
      metadata: {
        mode: "agent",
        project_id: run.projectId,
        build: toRunSnapshot(run),
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
      created_at: nowTs(),
    });
    await d.collection("conversations").doc(input.conversationId).set({ updated_at: nowTs(), mode: "agent" }, { merge: true });
  } catch {
    /* chat persistence is best-effort; the run itself is already stored */
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
  if (!isTogetherConfigured()) {
    note("generate", "warn", "Image generation is not configured on this deployment (Together AI key missing) — the project will use inline SVG instead.");
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
    note("generate", "info", `Generating image asset ${path} with Together AI…`);
    await emit("generate");
    try {
      const image = await generateTogetherImage(request.prompt, { width: 768, height: 768, signal: AbortSignal.timeout(90_000) });
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
    .set({ run: toFirestoreRun(run), updated_at: nowTs() }, { merge: true })
    .catch(() => {});
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
          now: Date.now(),
        }),
      ),
      created_at: nowTs(),
      updated_at: nowTs(),
    })
    .catch(() => {});
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
