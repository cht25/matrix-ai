// Unified Tool Registry: model requests never execute tools directly; the
// backend validates args and independently authorizes every call.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  RiskTier,
  ToolRegistry,
  requiresApproval,
  riskRank,
  type ToolContext,
} from "@/lib/ai/tools/registry";

const ctx: ToolContext = { db: {}, uid: "u1", email: null, requestId: "r1" };
const allowAll = async () => true;
const denyAll = async () => false;

function makeRegistry() {
  const reg = new ToolRegistry();
  reg.register({
    id: "demo.read",
    description: "read demo",
    category: "general",
    risk: RiskTier.LOW,
    requiredPermissions: [],
    scopes: ["demo:read"],
    environment: "server",
    timeoutSeconds: 5,
    approvalRequired: false,
    auditRequired: false,
    rateLimitPerMinute: 30,
    inputSchema: z.object({ q: z.string().min(1) }),
    handler: vi.fn(async (_c, input: { q: string }) => ({ ok: true, data: { echo: input.q } })),
  });
  reg.register({
    id: "demo.danger",
    description: "dangerous demo",
    category: "general",
    risk: RiskTier.HIGH,
    requiredPermissions: ["demo.admin"],
    scopes: ["demo:admin"],
    environment: "isolated-worker",
    timeoutSeconds: 10,
    approvalRequired: true,
    auditRequired: true,
    rateLimitPerMinute: 5,
    inputSchema: z.object({}),
    handler: vi.fn(async () => ({ ok: true })),
  });
  return reg;
}

describe("risk tiers", () => {
  it("ranks and requires approval above LOW", () => {
    expect(riskRank(RiskTier.LOW)).toBeLessThan(riskRank(RiskTier.MEDIUM));
    expect(requiresApproval(RiskTier.LOW)).toBe(false);
    expect(requiresApproval(RiskTier.MEDIUM)).toBe(true);
    expect(requiresApproval(RiskTier.HIGH)).toBe(true);
    expect(requiresApproval(RiskTier.CRITICAL)).toBe(true);
  });
});

describe("ToolRegistry", () => {
  it("rejects duplicate and invalid ids", () => {
    const reg = new ToolRegistry();
    const spec = {
      id: "a.b", description: "", category: "general" as const, risk: RiskTier.LOW,
      requiredPermissions: [], scopes: [], environment: "server" as const, timeoutSeconds: 5,
      approvalRequired: false, auditRequired: false, rateLimitPerMinute: 10,
      inputSchema: z.object({}), handler: async () => ({ ok: true }),
    };
    reg.register(spec);
    expect(() => reg.register(spec)).toThrow(/Duplicate/);
    expect(() => reg.register({ ...spec, id: "BAD ID!" })).toThrow(/Invalid tool id/);
    expect(() => reg.register({ ...spec, id: "x.y", timeoutSeconds: 0 })).toThrow(/timeout/);
    expect(() =>
      reg.register({ ...spec, id: "c.d", risk: RiskTier.CRITICAL, approvalRequired: false }),
    ).toThrow(/approvalRequired/);
  });

  it("validates args against the zod schema", () => {
    const reg = makeRegistry();
    expect(reg.validateArgs("demo.read", { q: "hi" })).toEqual({ q: "hi" });
    expect(() => reg.validateArgs("demo.read", { q: "" })).toThrow(/Invalid arguments/);
    expect(() => reg.validateArgs("demo.read", {})).toThrow(/Invalid arguments/);
    expect(() => reg.validateArgs("nope", {})).toThrow(/Unknown tool/);
  });

  it("denies calls when the authorizer rejects permissions", async () => {
    const reg = makeRegistry();
    const decision = await reg.authorize(ctx, "demo.danger", denyAll);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("MISSING_PERMISSIONS");
    const result = await reg.call(ctx, "demo.danger", {}, denyAll);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("MISSING_PERMISSIONS");
    expect(reg.get("demo.danger")!.handler).not.toHaveBeenCalled();
  });

  it("requires an approval id for MEDIUM+ risk tools", async () => {
    const reg = makeRegistry();
    const decision = await reg.authorize(ctx, "demo.danger", allowAll);
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toBe("APPROVAL_REQUIRED");
    const approved = await reg.call({ ...ctx, approvalId: "ap-1" }, "demo.danger", {}, allowAll);
    expect(approved.ok).toBe(true);
  });

  it("executes LOW-risk tools through validation and returns real results", async () => {
    const reg = makeRegistry();
    const res = await reg.call(ctx, "demo.read", { q: "hello" }, allowAll);
    expect(res).toEqual({ ok: true, data: { echo: "hello" } });
  });

  it("returns honest errors — never fabricates success — on handler failure", async () => {
    const reg = new ToolRegistry();
    reg.register({
      id: "demo.fail",
      description: "fails",
      category: "general",
      risk: RiskTier.LOW,
      requiredPermissions: [],
      scopes: [],
      environment: "server",
      timeoutSeconds: 1,
      approvalRequired: false,
      auditRequired: false,
      rateLimitPerMinute: 30,
      inputSchema: z.object({}),
      handler: async () => {
        throw new Error("provider exploded");
      },
    });
    const res = await reg.call(ctx, "demo.fail", {}, allowAll);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("provider exploded");
  });

  it("exposes model-facing schemas", () => {
    const reg = makeRegistry();
    const schemas = reg.schemasForModel();
    expect(schemas.map((s) => s.name)).toEqual(["demo.read", "demo.danger"]);
    expect(schemas[0].input_schema).toBeTypeOf("object");
  });
});
