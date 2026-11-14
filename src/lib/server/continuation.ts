// Multi-session continuation for build runs.
//
// One user request = one conversation, one project, one build run. When the
// work cannot finish in one execution session (the request's time budget, a
// provider that is rate-limited on every connected account, a server restart)
// the run is paused with everything needed to pick it up stored on the run
// document. The next execution session continues the SAME run: no new chat,
// no new project, no new task, no repeated user message.
//
// Files are never part of this record — they are already in project storage,
// which is the single authoritative copy every session reads from.
import "server-only";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import { RpcError } from "@/lib/server/errors";
import type { SessionUser } from "@/lib/firebase/session";
import { MAX_RUN_SEGMENTS, type BuildActions, type BuildEnvironment, type RunContinuation } from "@/lib/deploy/stages";

export type ResumePhase = RunContinuation["phase"];

/** Everything a later session needs to continue the request. */
export type ResumeState = {
  prompt: string;
  projectId: string | null;
  workspaceProjectId: string | null;
  conversationId: string | null;
  taskId: string | null;
  requestId: string | null;
  actions: BuildActions;
  chatMode: "code" | "agent";
  environment: BuildEnvironment;
  slug: string | null;
  allowOverride: boolean;
  isTemporary: boolean;
  workspaceOnly: boolean;
  maxFixAttempts: number | null;
  /** Where the next session starts. */
  phase: ResumePhase;
  /** Sessions used so far. */
  segment: number;
  /** Assistant message that reports this run in the chat (one per run). */
  messageId: string | null;
  completed: string[];
  pending: string[];
  /** Problems still open when the session ended. */
  unresolved: string[];
  /** Repair attempts already spent, so the budget spans sessions. */
  attemptsUsed: number;
  /** Project revision the saved progress corresponds to. */
  revision: number | null;
};

const CLAIM_TTL_MS = 330_000;

function clean(state: ResumeState): Record<string, unknown> {
  return {
    ...state,
    prompt: state.prompt.slice(0, 12_000),
    completed: state.completed.slice(0, 30).map((item) => item.slice(0, 200)),
    pending: state.pending.slice(0, 30).map((item) => item.slice(0, 200)),
    unresolved: state.unresolved.slice(0, 30).map((item) => item.slice(0, 300)),
  };
}

/** Save (or update) the resume record. Called at every phase boundary. */
export async function saveResumeState(d: Db, runId: string, state: ResumeState): Promise<void> {
  await d.collection("build_runs").doc(runId).set({ resume: { ...clean(state), saved_at: nowTs() }, updated_at: nowTs() }, { merge: true });
}

/** The run finished for good: nothing is left to continue. */
export async function clearResumeState(d: Db, runId: string): Promise<void> {
  await d.collection("build_runs").doc(runId).set({ resume: null, resume_claim: null, updated_at: nowTs() }, { merge: true });
}

export function parseResumeState(raw: unknown): ResumeState | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.prompt !== "string") return null;
  const actions = (data.actions ?? {}) as Record<string, unknown>;
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  return {
    prompt: data.prompt,
    projectId: text(data.projectId),
    workspaceProjectId: text(data.workspaceProjectId),
    conversationId: text(data.conversationId),
    taskId: text(data.taskId),
    requestId: text(data.requestId),
    actions: { build: actions.build === true, publish: actions.publish === true, preview: actions.preview === true, fix: actions.fix === true },
    chatMode: data.chatMode === "code" ? "code" : "agent",
    environment: data.environment === "preview" ? "preview" : "production",
    slug: text(data.slug),
    allowOverride: data.allowOverride === true,
    isTemporary: data.isTemporary === true,
    workspaceOnly: data.workspaceOnly === true,
    maxFixAttempts: typeof data.maxFixAttempts === "number" ? data.maxFixAttempts : null,
    phase: data.phase === "repair" || data.phase === "publish" ? data.phase : "generate",
    segment: typeof data.segment === "number" && data.segment >= 1 ? Math.floor(data.segment) : 1,
    messageId: text(data.messageId),
    completed: list(data.completed),
    pending: list(data.pending),
    unresolved: list(data.unresolved),
    attemptsUsed: typeof data.attemptsUsed === "number" ? data.attemptsUsed : 0,
    revision: typeof data.revision === "number" ? data.revision : null,
  };
}

export type ResumeClaim = { state: ResumeState; claimId: string };

/**
 * Atomically take the right to continue a run. Two tabs, a retry and the
 * background job can all ask at once; exactly one gets the claim, the others
 * are told the run is already continuing.
 */
export async function claimResume(d: Db, user: SessionUser, runId: string, now = Date.now()): Promise<ResumeClaim> {
  const ref = d.collection("build_runs").doc(runId);
  const claimId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || !data || data.owner_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
    const state = parseResumeState(data.resume);
    if (!state) throw new RpcError("NOTHING_TO_RESUME", 409, "This build has no saved progress to continue.");
    const run = (data.run ?? {}) as { status?: string; updatedAt?: number };
    if (run.status === "succeeded" || run.status === "cancelled") throw new RpcError("NOTHING_TO_RESUME", 409, "This build already finished.");
    const claim = data.resume_claim as { at?: number } | null | undefined;
    if (claim?.at && now - claim.at < CLAIM_TTL_MS && (run.status === "running" || run.status === "requested") && now - Number(run.updatedAt ?? 0) < 180_000) {
      throw new RpcError("ALREADY_RESUMING", 409, "This build is already continuing.");
    }
    if (run.status === "running" && now - Number(run.updatedAt ?? 0) < 60_000) {
      throw new RpcError("ALREADY_RESUMING", 409, "This build is still running.");
    }
    if (state.segment >= MAX_RUN_SEGMENTS) {
      throw new RpcError("CONTINUATION_LIMIT", 409, `This build was continued ${MAX_RUN_SEGMENTS - 1} times without finishing. Its files are saved in the project; send a new, smaller request to carry on.`);
    }
    tx.set(ref, { resume_claim: { id: claimId, at: now }, updated_at: nowTs() }, { merge: true });
    const messageId = typeof data.resume_message_id === "string" && data.resume_message_id ? data.resume_message_id : state.messageId;
    return { state: { ...state, messageId }, claimId };
  });
}

/** Runs that stopped with saved progress and are due to continue (background recovery). */
export async function listResumableRuns(d: Db, now = Date.now(), limit = 20): Promise<Array<{ runId: string; ownerId: string; state: ResumeState; status: string; retryAt: number | null }>> {
  const snap = await d.collection("build_runs").where("resumable", "==", true).get();
  const out: Array<{ runId: string; ownerId: string; state: ResumeState; status: string; retryAt: number | null }> = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const state = parseResumeState(data.resume);
    const run = (data.run ?? {}) as { status?: string; updatedAt?: number; continuation?: { retryAt?: number | null } };
    if (!state || state.segment >= MAX_RUN_SEGMENTS) continue;
    const stale = (run.status === "running" || run.status === "requested") && now - Number(run.updatedAt ?? 0) > 300_000;
    if (run.status !== "paused" && !stale) continue;
    const retryAt = run.continuation?.retryAt ?? null;
    if (retryAt && retryAt > now) continue;
    out.push({ runId: doc.id, ownerId: String(data.owner_id ?? ""), state, status: stale ? "interrupted" : "paused", retryAt });
    if (out.length >= limit) break;
  }
  return out;
}
