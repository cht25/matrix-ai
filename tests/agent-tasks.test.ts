// Agent task checkpoints: owner-scoped, append-only, honest states.
import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  appendCheckpoint,
  createAgentTask,
  getAgentTask,
  listAgentTasks,
  setTaskStatus,
  RpcError,
} from "@/lib/server/agent-tasks";

type DocData = Record<string, unknown>;
function makeDb() {
  const docs = new Map<string, DocData>();
  const key = (path: string, id: string) => `${path}/${id}`;
  const collection = (name: string) => ({
    doc: (id?: string) => {
      const path = name;
      const docId = id ?? `gen_${docs.size}_${Math.random().toString(36).slice(2, 8)}`;
      const self = {
        id: docId,
        get: async () => ({
          id: docId,
          exists: docs.has(key(path, docId)),
          data: () => docs.get(key(path, docId)),
          ref: undefined as unknown,
        }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          const k = key(path, docId);
          docs.set(k, opts?.merge ? { ...(docs.get(k) ?? {}), ...data } : data);
        },
        collection: (sub: string) => subCollection(`${path}/${docId}`, sub),
      };
      (self.get as unknown as { _patch?: boolean });
      // attach ref lazily
      const origGet = self.get;
      self.get = (async () => {
        const snap = (await origGet()) as { ref?: unknown };
        snap.ref = self;
        return snap;
      }) as typeof self.get;
      return self;
    },
    add: async (data: DocData) => {
      const id = `auto_${docs.size}`;
      docs.set(key(name, id), data);
      return { id };
    },
    where: (field: string, op: string, value: unknown) => ({
      get: async () => {
        const matched = [...docs.entries()]
          .filter(([k, v]) => k.startsWith(`${name}/`) && !k.slice(name.length + 1).includes("/"))
          .filter(([, v]) => (op === "==" ? v[field] === value : true))
          .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v, exists: true }));
        return { empty: matched.length === 0, docs: matched, size: matched.length };
      },
    }),
  });
  const subCollection = (parentPath: string, sub: string) => ({
    doc: (id: string) => ({
      id,
      set: async (data: DocData) => {
        docs.set(`${parentPath}/${sub}/${id}`, data);
      },
      get: async () => ({ id, exists: docs.has(`${parentPath}/${sub}/${id}`), data: () => docs.get(`${parentPath}/${sub}/${id}`) }),
    }),
    get: async () => {
      const prefix = `${parentPath}/${sub}/`;
      const matched = [...docs.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v, exists: true }));
      return { empty: matched.length === 0, docs: matched, size: matched.length };
    },
  });
  return { collection, _docs: docs } as unknown as Parameters<typeof createAgentTask>[0] & {
    _docs: Map<string, DocData>;
  };
}

const user = { uid: "task-user", email: "t@x.com", emailVerified: true };
// createAgentTask reads back via ref.get(); the stub stores Timestamps — emulate.
function ts() {
  return Timestamp.now();
}

describe("agent tasks", () => {
  it("creates, checkpoints and reads a task with an ordered trail", async () => {
    const d = makeDb();
    // createAgentTask returns the raw doc; patch to ISO-ish shape for assertions
    const created = await createAgentTask(d, user, { title: "Build shop", goal: "Create a shop site" });
    const id = (created as unknown as { id?: string }).id ?? [...d._docs.keys()].find((k) => k.startsWith("agent_tasks/"))!.split("/")[1];
    await appendCheckpoint(d, user, id, { step: "inspect", state: "ok", detail: "repo scanned" });
    await appendCheckpoint(d, user, id, { step: "plan", state: "ok", detail: "3 steps" });
    await appendCheckpoint(d, user, id, { step: "deploy_approval", state: "needs_approval" });
    const { task, checkpoints } = await getAgentTask(d, user, id);
    expect(checkpoints.map((c) => c.step)).toEqual(["inspect", "plan", "deploy_approval"]);
    expect(checkpoints.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(checkpoints[2].state).toBe("needs_approval");
    expect(task.title).toBe("Build shop");
  });

  it("rejects invalid steps/states and closed tasks", async () => {
    const d = makeDb();
    await createAgentTask(d, user, { title: "T", goal: "g" });
    const id = [...d._docs.keys()].find((k) => k.startsWith("agent_tasks/"))!.split("/")[1];
    await expect(appendCheckpoint(d, user, id, { step: "hack", state: "ok" })).rejects.toThrow(RpcError);
    await expect(appendCheckpoint(d, user, id, { step: "plan", state: "weird" as never })).rejects.toThrow(RpcError);
    await setTaskStatus(d, user, id, "completed");
    await expect(appendCheckpoint(d, user, id, { step: "plan", state: "ok" })).rejects.toThrow(RpcError);
  });

  it("enforces ownership and lists only own tasks", async () => {
    const d = makeDb();
    await createAgentTask(d, user, { title: "Mine", goal: "g" });
    await createAgentTask(d, { ...user, uid: "other" }, { title: "Theirs", goal: "g" });
    const mine = await listAgentTasks(d, user);
    expect(mine.length).toBe(1);
    expect(mine[0].title).toBe("Mine");
    const id = [...d._docs.keys()].find((k) => k.startsWith("agent_tasks/"))!.split("/")[1];
    await expect(getAgentTask(d, { ...user, uid: "intruder" }, id)).rejects.toThrow(RpcError);
  });
});
