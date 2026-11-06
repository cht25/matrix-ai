// Agent Tool Gateway: only the guarded server path executes tools; denials,
// approvals and rate limits are audited, never hidden.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RiskTier, toolRegistry } from "@/lib/ai/tools/registry";
import { executeAgentTool, describeTools } from "@/lib/server/tool-gateway";

// --- minimal Firestore stub ---------------------------------------------------
type DocData = Record<string, unknown>;
function makeDb() {
  const docs = new Map<string, DocData>();
  const collection = (name: string) => ({
    doc: (id: string) => ({
      id,
      get: async () => ({ id, exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`) }),
      set: async (data: DocData, opts?: { merge?: boolean }) => {
        const k = `${name}/${id}`;
        docs.set(k, opts?.merge ? { ...(docs.get(k) ?? {}), ...data } : data);
      },
    }),
    add: async (data: DocData) => {
      const id = `auto_${docs.size}`;
      docs.set(`${name}/${id}`, data);
      return { id };
    },
    where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
  });
  return { collection, _docs: docs } as unknown as Parameters<typeof executeAgentTool>[0] & {
    _docs: Map<string, DocData>;
  };
}

// --- test tools ---------------------------------------------------------------
toolRegistry.register({
  id: "test.ping",
  description: "test tool",
  category: "general",
  risk: RiskTier.LOW,
  requiredPermissions: [],
  scopes: ["test:read"],
  environment: "server",
  timeoutSeconds: 5,
  approvalRequired: false,
  auditRequired: true,
  rateLimitPerMinute: 100,
  inputSchema: z.object({ n: z.number().optional() }),
  handler: async (_ctx, input: { n?: number }) => ({ ok: true, data: { pong: input.n ?? 1 } }),
});
toolRegistry.register({
  id: "test.danger",
  description: "requires approval",
  category: "general",
  risk: RiskTier.HIGH,
  requiredPermissions: [],
  scopes: ["test:admin"],
  environment: "isolated-worker",
  timeoutSeconds: 5,
  approvalRequired: true,
  auditRequired: true,
  rateLimitPerMinute: 100,
  inputSchema: z.object({}),
  handler: async () => ({ ok: true }),
});

const user = { uid: "gw-user", email: "g@x.com", emailVerified: true };

describe("tool gateway", () => {
  it("executes a LOW-risk tool and audits it", async () => {
    const d = makeDb();
    const res = await executeAgentTool(d, user, "test.ping", { n: 42 });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ pong: 42 });
    expect(res.request_id).toMatch(/^tool_/);
    const audits = [...d._docs.keys()].filter((k) => k.startsWith("audit_logs/"));
    expect(audits.length).toBe(1);
  });

  it("blocks HIGH-risk tools without an approval id and records a security event", async () => {
    const d = makeDb();
    const res = await executeAgentTool(d, user, "test.danger", {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("APPROVAL_REQUIRED");
    const events = [...d._docs.entries()].filter(([k]) => k.startsWith("security_events/"));
    expect(events.length).toBe(1);
    expect(String(events[0][1].event_type)).toBe("tool_approval_required");
  });

  it("runs HIGH-risk tools when an approval id is supplied", async () => {
    const d = makeDb();
    const res = await executeAgentTool(d, user, "test.danger", {}, { approvalId: "ap-1" });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const d = makeDb();
    const res = await executeAgentTool(d, user, "test.missing", {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("UNKNOWN_TOOL");
  });

  it("rate limits a user after too many calls", async () => {
    const d = makeDb();
    let last: Awaited<ReturnType<typeof executeAgentTool>> | null = null;
    for (let i = 0; i < 25; i++) last = await executeAgentTool(d, { ...user, uid: "gw-ratelimit" }, "test.ping", {});
    expect(last!.ok).toBe(false);
    expect(last!.error).toBe("RATE_LIMITED");
  });

  it("describes registered tools without exposing handlers", () => {
    const tools = describeTools();
    const ids = tools.map((t) => t.id);
    expect(ids).toContain("projects.list");
    expect(ids).toContain("github.list_repos");
    expect(ids).toContain("devices.list");
    expect(ids).toContain("family.list");
    for (const t of tools) {
      expect(t).not.toHaveProperty("handler");
      expect(typeof t.approvalRequired).toBe("boolean");
    }
  });
});
