import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cancelRun, createBuildRun } from "@/lib/deploy/stages";
import { bindBuildTask, createAgentTask, executionStateForRun, getAgentTask, syncBuildTask } from "@/lib/server/agent-tasks";
import type { Db } from "@/lib/firebase/admin";

const user = { uid: "u1", email: "u@example.com", emailVerified: true };
function dbFixture() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({ id: path.split("/").at(-1)!, get: async () => ({ exists: docs.has(path), data: () => docs.get(path), ref: ref(path) }), set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data); }, collection: (sub: string) => collection(`${path}/${sub}`) });
  const collection = (name: string) => ({ doc: (id = `id${docs.size}`) => ref(`${name}/${id}`), add: async (data: Record<string, unknown>) => { const id = `id${docs.size}`; docs.set(`${name}/${id}`, data); return ref(`${name}/${id}`); }, get: async () => ({ docs: [...docs.entries()].filter(([key]) => key.startsWith(`${name}/`)).map(([key, data]) => ({ id: key.split("/").at(-1)!, data: () => data })), empty: true }) });
  return { collection, _docs: docs } as unknown as Db & { _docs: Map<string, Record<string, unknown>> };
}

describe("Agent task state is server-written and build-truthful", () => {
  it("maps real run outcomes to execution states and never promotes failure to completed", async () => {
    const d = dbFixture();
    const task = await createAgentTask(d, user, { title: "Build", goal: "Build a site" });
    let run = createBuildRun({ id: "r1", taskId: task.id, actions: { build: true, publish: true, preview: false }, now: 1 });
    expect(executionStateForRun(run)).toBe("QUEUED");
    await bindBuildTask(d, user, task.id, { build_run_id: run.id });
    run = { ...run, status: "failed", error: { code: "BUILD_FAILED", message: "no" } };
    expect(executionStateForRun(run)).toBe("FAILED");
    await syncBuildTask(d, user, task.id, run);
    const { task: stored } = await getAgentTask(d, user, task.id);
    expect(stored.status).toBe("failed");
    expect(stored.execution_state).toBe("FAILED");
    expect(stored.build_status).toBe("failed");
  });
  it("cancellation is terminal and distinct from success", () => {
    const run = createBuildRun({ id: "r2", actions: { build: true, publish: false, preview: true }, now: 1 });
    const cancelled = cancelRun(run, 2);
    expect(cancelled.status).toBe("cancelled");
    expect(executionStateForRun(cancelled)).toBe("CANCELLED");
    expect(cancelRun({ ...run, status: "succeeded" }, 3).status).toBe("succeeded");
  });
  it("browser RPC cannot fabricate checkpoints or completion", () => {
    const rpc = readFileSync("src/app/api/rpc/route.ts", "utf8");
    expect(rpc).toContain('throw new RpcError("SERVER_WRITTEN", 403)');
    expect(rpc).toContain("cancelAgentTask");
    const route = readFileSync("src/app/api/build/route.ts", "utf8");
    expect(route).toContain("createAgentTask");
    expect(route).toContain("TASK_STORAGE_UNAVAILABLE");
    expect(route).toContain("export async function DELETE");
    const pipeline = readFileSync("src/lib/server/build.ts", "utf8");
    expect(pipeline).toContain("syncBuildTask");
    expect(pipeline).toContain("cancel_requested");
  });
});
