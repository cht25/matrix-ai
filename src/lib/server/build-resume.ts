// Continue a build run in a new execution session.
//
// Used by the build route (the open chat continues its own run) and by the
// background recovery job (nobody is watching). Both go through claimResume,
// so a run is only ever continued by one session at a time.
import "server-only";
import type { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { FirestoreDeploymentProvider } from "@/lib/deploy/firestore-provider";
import type { DeploymentProvider } from "@/lib/deploy/provider";
import { runFromFirestore } from "@/lib/deploy/run-store";
import { applyStaleness, type BuildRun } from "@/lib/deploy/stages";
import { runBuildPipeline, type BuildPipelineInput, type BuildPipelineResult } from "@/lib/server/build";
import { claimResume, listResumableRuns, type ResumeState } from "@/lib/server/continuation";

export type PreparedResume = { state: ResumeState; run: BuildRun; input: BuildPipelineInput };

/** Claim the run and assemble the pipeline input for its next session. Throws RpcError when it cannot continue. */
export async function prepareResume(d: Db, user: SessionUser, runId: string, options: { provider?: DeploymentProvider; onEvent?: BuildPipelineInput["onEvent"]; aiBudgetMs?: number } = {}): Promise<PreparedResume> {
  const { state } = await claimResume(d, user, runId);
  const doc = await d.collection("build_runs").doc(runId).get();
  const stored = runFromFirestore(doc.data()?.run, Date.now());
  if (!stored) throw new RpcError("NOTHING_TO_RESUME", 409, "The saved build state could not be read.");
  const run = applyStaleness(stored, Date.now());
  return {
    state,
    run,
    input: {
      d,
      user,
      provider: options.provider ?? new FirestoreDeploymentProvider(d, user),
      runId,
      projectId: state.projectId,
      workspaceProjectId: state.workspaceProjectId,
      conversationId: state.conversationId,
      requestId: state.requestId ? `${state.requestId}-s${state.segment + 1}` : null,
      taskId: state.taskId,
      prompt: state.prompt,
      actions: state.actions,
      environment: state.environment,
      slug: state.slug,
      allowOverride: state.allowOverride,
      isTemporary: state.isTemporary,
      workspaceOnly: state.workspaceOnly,
      chatMode: state.chatMode,
      maxFixAttempts: state.maxFixAttempts ?? undefined,
      resume: { state, run },
      onEvent: options.onEvent,
      aiBudgetMs: options.aiBudgetMs,
    },
  };
}

export async function resumeBuildRun(d: Db, user: SessionUser, runId: string, options: Parameters<typeof prepareResume>[3] = {}): Promise<BuildPipelineResult> {
  const prepared = await prepareResume(d, user, runId, options);
  return runBuildPipeline(prepared.input);
}

export type RecoveryOutcome = { runId: string; status: string; detail: string };

/**
 * Background recovery: continue paused runs whose wait is over and runs that
 * were cut off by a restart. Safe to call repeatedly and concurrently — every
 * run is claimed before it is touched.
 */
export async function recoverInterruptedRuns(d: Db, options: { limit?: number; budgetMs?: number; providerFor?: (user: SessionUser) => DeploymentProvider } = {}): Promise<RecoveryOutcome[]> {
  const started = Date.now();
  const budget = options.budgetMs ?? 240_000;
  const due = await listResumableRuns(d, started, options.limit ?? 3);
  const out: RecoveryOutcome[] = [];
  for (const item of due) {
    const remaining = budget - (Date.now() - started);
    if (remaining < 45_000) {
      out.push({ runId: item.runId, status: "deferred", detail: "Not enough time left in this job run." });
      continue;
    }
    if (!item.ownerId) continue;
    const user: SessionUser = { uid: item.ownerId, email: null, emailVerified: true };
    try {
      const result = await resumeBuildRun(d, user, item.runId, { provider: options.providerFor?.(user), aiBudgetMs: Math.max(20_000, remaining - 40_000) });
      out.push({ runId: item.runId, status: result.run.status, detail: result.run.error?.message ?? result.run.continuation?.message ?? "" });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "RESUME_FAILED";
      out.push({ runId: item.runId, status: code === "ALREADY_RESUMING" ? "busy" : "error", detail: code });
    }
  }
  return out;
}
