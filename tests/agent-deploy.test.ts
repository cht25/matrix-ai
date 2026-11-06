// Agent task → Vercel deploy flow: checkpoints record REAL outcomes only;
// approval is mandatory; failures are marked failed, never successful.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createAgentTask, getAgentTask } from "@/lib/server/agent-tasks";
import { deployAgentTask, RpcError } from "@/lib/server/agent-deploy";

type DocData = Record<string, unknown>;
function makeDb() {
  const docs = new Map<string, DocData>();
  const collection = (name: string) => ({
    doc: (id?: string) => {
      const docId = id ?? `gen_${Math.random().toString(36).slice(2, 10)}`;
      const self = {
        id: docId,
        get: async () => {
          const snap = { id: docId, exists: docs.has(`${name}/${docId}`), data: () => docs.get(`${name}/${docId}`) };
          return { ...snap, ref: self };
        },
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          const k = `${name}/${docId}`;
          docs.set(k, opts?.merge ? { ...(docs.get(k) ?? {}), ...data } : data);
        },
        collection: (sub: string) => ({
          doc: (cid: string) => ({ set: async (data: DocData) => docs.set(`${name}/${docId}/${sub}/${cid}`, data) }),
          get: async () => {
            const prefix = `${name}/${docId}/${sub}/`;
            const matched = [...docs.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v, exists: true }));
            return { empty: matched.length === 0, docs: matched, size: matched.length };
          },
        }),
      };
      return self;
    },
    add: async (data: DocData) => {
      const id = `auto_${docs.size}`;
      docs.set(`${name}/${id}`, data);
      return { id };
    },
    where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
  });
  return { collection, _docs: docs } as unknown as Parameters<typeof createAgentTask>[0] & { _docs: Map<string, DocData> };
}

function okFetch() {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/v13/deployments") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "dpl_9", url: "x.vercel.app", readyState: "READY", state: "READY", createdAt: 1 }), { status: 200 });
    }
    if (path.includes("/v13/deployments/dpl_9")) {
      return new Response(JSON.stringify({ id: "dpl_9", url: "x.vercel.app", readyState: "READY", state: "READY", createdAt: 1 }), { status: 200 });
    }
    if (path.includes("/domains")) {
      return new Response(JSON.stringify({ name: "shop.apps.thamjj13.top", verified: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function failFetch() {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/v13/deployments") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "dpl_bad", url: "y.vercel.app", readyState: "BUILDING", state: "BUILDING", createdAt: 1 }), { status: 200 });
    }
    if (path.includes("/v13/deployments/dpl_bad")) {
      return new Response(JSON.stringify({ id: "dpl_bad", url: "y.vercel.app", readyState: "ERROR", state: "ERROR", createdAt: 1 }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const user = { uid: "deployer", email: "d@x.com", emailVerified: true };

beforeEach(() => {
  process.env.VERCEL_TOKEN = "tok";
  process.env.VERCEL_APPS_DOMAIN = "apps.thamjj13.top";
});
afterEach(() => {
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_APPS_DOMAIN;
});

describe("agent task deploy flow", () => {
  it("requires explicit approval", async () => {
    const d = makeDb();
    await createAgentTask(d, user, { title: "t", goal: "g" });
    const id = [...d._docs.keys()].find((k) => k.startsWith("agent_tasks/"))!.split("/")[1];
    await expect(deployAgentTask(d, user, { task_id: id, vercel_project_id: "prj_1", approve: false })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("records the full checkpoint trail on success", async () => {
    const d = makeDb();
    await createAgentTask(d, user, { title: "Shop", goal: "deploy shop" });
    const id = [...d._docs.keys()].find((k) => k.startsWith("agent_tasks/"))!.split("/")[1];
    const res = await deployAgentTask(d, user, {
      task_id: id,
      vercel_project_id: "prj_1",
      approve: true,
      subdomain: "shop",
      fetchImpl: okFetch(),
    });
    expect(res.deployment.url).toBe("https://x.vercel.app");
    expect(res.domain?.name).toBe("shop.apps.thamjj13.top");
    const { task, checkpoints } = await getAgentTask(d, user, id);
    expect(task.status).toBe("completed");
    expect(checkpoints.map((c) => c.step)).toEqual(["deploy_approval", "deploy", "deploy", "verify", "verify", "report"]);
    expect(checkpoints.every((c) => c.state === "ok" || c.state === "started")).toBe(true);
  });

  it("marks the task failed when the deployment errors — never fake success", async () => {
    const d = makeDb();
    await createAgentTask(d, user, { title: "Bad", goal: "g" });
    const id = [...d._docs.keys()].find((k) => k.startsWith("agent_tasks/"))!.split("/")[1];
    await expect(
      deployAgentTask(d, user, { task_id: id, vercel_project_id: "prj_1", approve: true, fetchImpl: failFetch() }),
    ).rejects.toThrow(RpcError);
    const { task, checkpoints } = await getAgentTask(d, user, id);
    expect(task.status).toBe("failed");
    expect(checkpoints.some((c) => c.step === "deploy" && c.state === "failed")).toBe(true);
  });
});
