// =============================================================================
// MATRIX AI — Agent task checkpoints (server-only).
//
// Every Agent run is a persisted task with an ordered checkpoint trail
// (plan → inspect → edit → build/test → repair → deploy approval → verify).
// Checkpoints are written ONLY by the server after real execution results;
// a checkpoint can never claim a step succeeded that did not run.
//   agent_tasks/{id}                    → task header (owner-scoped)
//   agent_tasks/{id}/checkpoints/{n}    → ordered, append-only trail
// =============================================================================

import "server-only";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";

export { RpcError };

const TASKS = "agent_tasks";

export const TASK_STATUSES = ["planning", "running", "awaiting_approval", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CHECKPOINT_STEPS = [
  "inspect",
  "plan",
  "permission_check",
  "edit",
  "build",
  "test",
  "diagnose",
  "repair",
  "deploy_approval",
  "deploy",
  "verify",
  "report",
] as const;
export type CheckpointStep = (typeof CHECKPOINT_STEPS)[number];
export type CheckpointState = "started" | "ok" | "failed" | "skipped" | "needs_approval";

export type AgentTask = {
  id: string;
  user_id: string;
  conversation_id: string | null;
  project_id: string | null;
  title: string;
  goal: string;
  model: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type Checkpoint = {
  n: number;
  step: string;
  state: CheckpointState;
  detail: string;
  at: string;
};

async function requireOwnedTask(d: Db, user: SessionUser, taskId: string) {
  const snap = await d.collection(TASKS).doc(taskId).get();
  if (!snap.exists || snap.data()?.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  return snap.ref;
}

export async function createAgentTask(
  d: Db,
  user: SessionUser,
  input: { title: string; goal: string; conversation_id?: string | null; project_id?: string | null; model?: string | null },
): Promise<AgentTask> {
  const title = input.title.trim().slice(0, 120);
  const goal = input.goal.trim().slice(0, 4000);
  if (!title || !goal) throw new RpcError("TASK_INVALID");
  const ref = d.collection(TASKS).doc();
  const now = nowTs();
  await ref.set({
    user_id: user.uid,
    conversation_id: input.conversation_id ?? null,
    project_id: input.project_id ?? null,
    title,
    goal,
    model: input.model ?? null,
    status: "planning",
    created_at: now,
    updated_at: now,
    finished_at: null,
  });
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: "agent_task.create",
    target_type: "agent_task",
    target_id: ref.id,
    reason: title,
    metadata: { project_id: input.project_id ?? null },
    created_at: now,
  });
  return (await ref.get()).data() as AgentTask & { created_at: unknown } as AgentTask;
}

/** Append one checkpoint. `state` must reflect a REAL outcome. */
export async function appendCheckpoint(
  d: Db,
  user: SessionUser,
  taskId: string,
  input: { step: string; state: CheckpointState; detail?: string },
): Promise<Checkpoint> {
  const ref = await requireOwnedTask(d, user, taskId);
  if (!CHECKPOINT_STEPS.includes(input.step as CheckpointStep)) throw new RpcError("STEP_INVALID");
  if (!["started", "ok", "failed", "skipped", "needs_approval"].includes(input.state)) throw new RpcError("STATE_INVALID");
  const taskSnap = await ref.get();
  if (["completed", "failed", "cancelled"].includes(String(taskSnap.data()?.status))) {
    throw new RpcError("TASK_CLOSED", 409);
  }
  const existing = await ref.collection("checkpoints").get();
  const n = existing.size + 1;
  const checkpoint: Checkpoint = {
    n,
    step: input.step,
    state: input.state,
    detail: (input.detail ?? "").slice(0, 500),
    at: new Date().toISOString(),
  };
  await ref.collection("checkpoints").doc(String(n).padStart(4, "0")).set({
    n,
    step: checkpoint.step,
    state: checkpoint.state,
    detail: checkpoint.detail,
    at: nowTs(),
  });
  await ref.set({ updated_at: nowTs() }, { merge: true });
  return checkpoint;
}

export async function setTaskStatus(
  d: Db,
  user: SessionUser,
  taskId: string,
  status: TaskStatus,
): Promise<AgentTask> {
  if (!TASK_STATUSES.includes(status)) throw new RpcError("STATUS_INVALID");
  const ref = await requireOwnedTask(d, user, taskId);
  const patch: Record<string, unknown> = { status, updated_at: nowTs() };
  if (status === "completed" || status === "failed" || status === "cancelled") patch.finished_at = nowTs();
  await ref.set(patch, { merge: true });
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: `agent_task.${status}`,
    target_type: "agent_task",
    target_id: taskId,
    reason: "",
    metadata: {},
    created_at: nowTs(),
  });
  const snap = await ref.get();
  return snap.data() as AgentTask;
}

export async function getAgentTask(d: Db, user: SessionUser, taskId: string): Promise<{ task: AgentTask; checkpoints: Checkpoint[] }> {
  const ref = await requireOwnedTask(d, user, taskId);
  const [taskSnap, cpSnap] = await Promise.all([ref.get(), ref.collection("checkpoints").get()]);
  const checkpoints = cpSnap.docs
    .map((c) => ({
      n: Number(c.data().n ?? 0),
      step: String(c.data().step ?? ""),
      state: c.data().state as CheckpointState,
      detail: String(c.data().detail ?? ""),
      at: c.data().at?.toDate?.().toISOString() ?? "",
    }))
    .sort((a, b) => a.n - b.n);
  return { task: taskSnap.data() as AgentTask, checkpoints };
}

export async function listAgentTasks(d: Db, user: SessionUser): Promise<AgentTask[]> {
  const snap = await d.collection(TASKS).where("user_id", "==", user.uid).get();
  return snap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        user_id: String(data.user_id ?? ""),
        conversation_id: data.conversation_id ?? null,
        project_id: data.project_id ?? null,
        title: String(data.title ?? ""),
        goal: String(data.goal ?? ""),
        model: data.model ?? null,
        status: (data.status ?? "planning") as TaskStatus,
        created_at: data.created_at?.toDate?.().toISOString() ?? "",
        updated_at: data.updated_at?.toDate?.().toISOString() ?? "",
        finished_at: data.finished_at ? data.finished_at.toDate().toISOString() : null,
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
}
