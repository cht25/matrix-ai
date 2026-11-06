// Automations: only registered LOW-risk tools may be attached; execution runs
// through the guarded registry and records real per-action outcomes.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RiskTier, toolRegistry } from "@/lib/ai/tools/registry";
import { validateAutomationActions } from "@/lib/automations";
import { createAutomation, listAutomations, runAutomation, setAutomationStatus, RpcError } from "@/lib/server/automations";

// Register a LOW test tool (real handler, no mocking of behavior).
toolRegistry.register({
  id: "test.auto",
  description: "automation-safe test tool",
  category: "general",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["test:read"],
  environment: "server",
  timeoutSeconds: 5,
  approvalRequired: false,
  auditRequired: false,
  rateLimitPerMinute: 100,
  inputSchema: z.object({}),
  handler: async () => ({ ok: true, data: { ran: true } }),
});
toolRegistry.register({
  id: "test.risky",
  description: "too risky for automation",
  category: "general",
  risk: RiskTier.HIGH,
  requiredPermissions: [],
  scopes: [],
  environment: "server",
  timeoutSeconds: 5,
  approvalRequired: true,
  auditRequired: true,
  rateLimitPerMinute: 100,
  inputSchema: z.object({}),
  handler: async () => ({ ok: true }),
});

type DocData = Record<string, unknown>;
function makeDb() {
  const docs = new Map<string, DocData>();
  const collection = (name: string) => ({
    doc: (id?: string) => {
      const docId = id ?? `gen_${Math.random().toString(36).slice(2, 10)}`;
      const self = {
        id: docId,
        get: async () => ({ id: docId, exists: docs.has(`${name}/${docId}`), data: () => docs.get(`${name}/${docId}`), ref: self }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          const k = `${name}/${docId}`;
          docs.set(k, opts?.merge ? { ...(docs.get(k) ?? {}), ...data } : data);
        },
      };
      return self;
    },
    add: async (data: DocData) => {
      const id = `auto_${docs.size}`;
      docs.set(`${name}/${id}`, data);
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
  return { collection, _docs: docs } as unknown as Parameters<typeof createAutomation>[0] & { _docs: Map<string, DocData> };
}

const user = { uid: "auto-user", email: "a@x.com", emailVerified: true };

describe("automation validation", () => {
  it("rejects malformed actions", () => {
    expect(() => validateAutomationActions([])).toThrow();
    expect(() => validateAutomationActions([{ tool: "BAD" }])).toThrow();
    expect(() => validateAutomationActions([{ tool: "a.b", args: "nope" }])).toThrow();
    expect(validateAutomationActions([{ tool: "test.auto" }])).toEqual([{ tool: "test.auto", args: {} }]);
  });
});

describe("automations backend", () => {
  it("rejects unknown and high-risk tools at creation", async () => {
    const d = makeDb();
    await expect(
      createAutomation(d, user, { name: "test automation", trigger: "manual", actions: [{ tool: "nope.nope" }] }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TOOL: nope.nope" });
    await expect(
      createAutomation(d, user, { name: "test automation", trigger: "manual", actions: [{ tool: "test.risky" }] }),
    ).rejects.toMatchObject({ code: "TOOL_RISK_TOO_HIGH_FOR_AUTOMATION: test.risky" });
  });

  it("requires a schedule for schedule triggers", async () => {
    const d = makeDb();
    await expect(
      createAutomation(d, user, { name: "test automation", trigger: "schedule", actions: [{ tool: "test.auto" }] }),
    ).rejects.toMatchObject({ code: "SCHEDULE_REQUIRED" });
  });

  it("creates, runs and records real outcomes; ownership enforced", async () => {
    const d = makeDb();
    await createAutomation(d, user, { name: "Morning brief", trigger: "schedule", schedule: "daily", actions: [{ tool: "test.auto" }] });
    const list = await listAutomations(d, user);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("Morning brief");
    const id = list[0].id;
    const run = await runAutomation(d, user, id, { triggerSource: "scheduler" });
    expect(run.ok).toBe(true);
    expect(run.results[0]).toMatchObject({ tool: "test.auto", ok: true });
    const after = await listAutomations(d, user);
    expect(after[0].run_count).toBe(1);
    expect(after[0].last_run_ok).toBe(true);
    // other users cannot run or pause it
    await expect(runAutomation(d, { ...user, uid: "other" }, id)).rejects.toThrow(RpcError);
    await expect(setAutomationStatus(d, { ...user, uid: "other" }, id, "paused")).rejects.toThrow(RpcError);
    await setAutomationStatus(d, user, id, "paused");
    const paused = await listAutomations(d, user);
    expect(paused[0].status).toBe("paused");
  });
});
