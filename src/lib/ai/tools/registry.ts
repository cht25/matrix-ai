// =============================================================================
// MATRIX AI — Unified Tool Registry (server-side, ARMx-inspired).
//
// Every capability the AI may invoke is one registered ToolSpec. A model may
// only *request* a tool by id with arguments; the registry validates the
// arguments against the zod input schema and the backend INDEPENDENTLY
// re-checks authorization (permissions, risk tier, approval) before the
// handler is ever invoked. A model requesting a tool never executes it.
//
// This module is intentionally free of server-only imports so it can be unit
// tested and reused by the AI gateway, the Agent runtime and admin tooling.
// =============================================================================

import { z, type ZodTypeAny } from "zod";

/**
 * Minimal zod-v3 → JSON Schema converter for model-facing tool schemas.
 * Supports the constructs MATRIX tool inputs use (objects, strings, numbers,
 * enums, arrays, optionals, defaults). Keeps the registry on zod v3 like the
 * rest of the codebase.
 */
function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const type = def?.typeName as string | undefined;
  switch (type) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      return { type: "object", properties, ...(required.length ? { required } : {}) };
    }
    case "ZodString": {
      const out: Record<string, unknown> = { type: "string" };
      if (def.checks) {
        for (const c of def.checks as Array<{ kind: string; value?: number }>) {
          if (c.kind === "min") out.minLength = c.value;
          if (c.kind === "max") out.maxLength = c.value;
        }
      }
      return out;
    }
    case "ZodNumber": {
      const out: Record<string, unknown> = { type: "number" };
      if (def.checks) {
        for (const c of def.checks as Array<{ kind: string; value?: number }>) {
          if (c.kind === "min") out.minimum = c.value;
          if (c.kind === "max") out.maximum = c.value;
          if (c.kind === "int") out.type = "integer";
        }
      }
      return out;
    }
    case "ZodEnum":
      return { type: "string", enum: def.values as unknown[] };
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type as ZodTypeAny) };
    case "ZodOptional":
    case "ZodNullable":
      return zodToJsonSchema(def.innerType as ZodTypeAny);
    case "ZodDefault":
      return { ...zodToJsonSchema(def.innerType as ZodTypeAny), default: (def.defaultValue as (() => unknown) | undefined)?.() };
    case "ZodBoolean":
      return { type: "boolean" };
    default:
      return { type: "object" };
  }
}

export enum RiskTier {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  CRITICAL = "critical",
}

export function riskRank(tier: RiskTier): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[tier];
}

/** Any tool at MEDIUM or above must never silently auto-execute. */
export function requiresApproval(tier: RiskTier, explicit = false): boolean {
  return explicit || riskRank(tier) >= riskRank(RiskTier.MEDIUM);
}

/** Where a tool handler is allowed to run. The gateway enforces the boundary. */
export type ToolEnvironment = "server" | "isolated-worker" | "device" | "external-api";

export type ToolCategory =
  | "research"
  | "projects"
  | "git"
  | "deploy"
  | "devices"
  | "family"
  | "automation"
  | "knowledge"
  | "voice"
  | "notifications"
  | "general";

/** Execution context handed to handlers. `db` is the Admin SDK Firestore. */
export interface ToolContext {
  db: unknown;
  uid: string;
  email: string | null;
  requestId: string;
  approvalId?: string;
  dryRun?: boolean;
}

/** Uniform result envelope — no fabricated success shape. */
export interface ToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  message?: string;
  error?: string;
}

export type ToolHandler<I> = (ctx: ToolContext, input: I) => Promise<ToolResult>;

/**
 * Independent authorization check supplied by the server layer (it knows the
 * RBAC tables). The registry never trusts the model's claim of permission.
 */
export type Authorizer = (ctx: ToolContext, permissions: readonly string[]) => Promise<boolean>;

export interface ToolSpec<I = unknown> {
  id: string;
  description: string;
  category: ToolCategory;
  risk: RiskTier;
  /** Permission codes the CALLER must hold (checked by the Authorizer). */
  requiredPermissions: readonly string[];
  /** Fine-grained scopes recorded in the audit log (e.g. "devices:read"). */
  scopes: readonly string[];
  environment: ToolEnvironment;
  timeoutSeconds: number;
  approvalRequired: boolean;
  auditRequired: boolean;
  rateLimitPerMinute: number;
  inputSchema: ZodTypeAny;
  handler: ToolHandler<I>;
}

export type AuthorizationDecision =
  | { allowed: true; requiresApproval: boolean; reason: string }
  | { allowed: false; requiresApproval: boolean; reason: string };

export class ToolArgumentError extends Error {
  readonly toolId: string;
  readonly issues: z.ZodIssue[];
  constructor(toolId: string, error: z.ZodError) {
    super(`Invalid arguments for tool "${toolId}"`);
    this.toolId = toolId;
    this.issues = error.issues;
  }
}

export class ToolNotFoundError extends Error {
  constructor(toolId: string) {
    super(`Unknown tool "${toolId}"`);
  }
}

export class ToolAuthorizationError extends Error {
  readonly toolId: string;
  readonly reason: string;
  constructor(toolId: string, reason: string) {
    super(`Tool "${toolId}" denied: ${reason}`);
    this.toolId = toolId;
    this.reason = reason;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register<I>(spec: ToolSpec<I>): void {
    if (!/^[a-z][a-z0-9_.]{2,63}$/.test(spec.id)) {
      throw new Error(`Invalid tool id "${spec.id}" (lowercase, dot-separated, 3-64 chars)`);
    }
    if (this.tools.has(spec.id)) throw new Error(`Duplicate tool id: ${spec.id}`);
    if (spec.timeoutSeconds <= 0 || spec.timeoutSeconds > 600) {
      throw new Error(`Tool "${spec.id}" has an invalid timeout (1-600s)`);
    }
    // Guard rail: MEDIUM+ risk must never silently auto-execute.
    if (requiresApproval(spec.risk, spec.approvalRequired) && !spec.approvalRequired && spec.risk === RiskTier.CRITICAL) {
      throw new Error(`CRITICAL tool "${spec.id}" must set approvalRequired`);
    }
    this.tools.set(spec.id, spec as ToolSpec);
  }

  get(id: string): ToolSpec | undefined {
    return this.tools.get(id);
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].sort((a, b) => riskRank(a.risk) - riskRank(b.risk) || a.id.localeCompare(b.id));
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** JSON schemas exposed to models — request-only, never execution rights. */
  schemasForModel(): Array<{ name: string; description: string; input_schema: unknown }> {
    return this.list().map((t) => ({
      name: t.id,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema),
    }));
  }

  /** Validate raw model arguments against the tool's input schema. */
  validateArgs<I>(id: string, args: unknown): I {
    const spec = this.tools.get(id);
    if (!spec) throw new ToolNotFoundError(id);
    const parsed = spec.inputSchema.safeParse(args ?? {});
    if (!parsed.success) throw new ToolArgumentError(id, parsed.error);
    return parsed.data as I;
  }

  /**
   * Backend authorization gate. Independently of anything the model claims,
   * checks the caller's permissions and the tool's risk/approval policy.
   */
  async authorize(
    ctx: ToolContext,
    id: string,
    authorizer: Authorizer,
  ): Promise<AuthorizationDecision> {
    const spec = this.tools.get(id);
    if (!spec) return { allowed: false, requiresApproval: false, reason: "UNKNOWN_TOOL" };
    if (spec.requiredPermissions.length > 0) {
      const granted = await authorizer(ctx, spec.requiredPermissions);
      if (!granted) {
        return {
          allowed: false,
          requiresApproval: requiresApproval(spec.risk, spec.approvalRequired),
          reason: "MISSING_PERMISSIONS",
        };
      }
    }
    const needsApproval = requiresApproval(spec.risk, spec.approvalRequired);
    if (needsApproval && !ctx.approvalId) {
      return { allowed: false, requiresApproval: true, reason: "APPROVAL_REQUIRED" };
    }
    return { allowed: true, requiresApproval: needsApproval, reason: "OK" };
  }

  /**
   * Full guarded invocation: authorize → validate → execute with timeout.
   * This is the ONLY path to a handler; models never call handlers directly.
   */
  async call(
    ctx: ToolContext,
    id: string,
    rawArgs: unknown,
    authorizer: Authorizer,
  ): Promise<ToolResult> {
    const spec = this.tools.get(id);
    if (!spec) return { ok: false, error: "UNKNOWN_TOOL" };
    const decision = await this.authorize(ctx, id, authorizer);
    if (!decision.allowed) {
      return { ok: false, error: decision.reason, data: { requiresApproval: decision.requiresApproval } };
    }
    let input: unknown;
    try {
      input = this.validateArgs(id, rawArgs);
    } catch (err) {
      if (err instanceof ToolArgumentError) {
        return { ok: false, error: "INVALID_ARGUMENTS", data: { issues: err.issues.map((i) => i.message) } };
      }
      throw err;
    }
    const timeout = new Promise<ToolResult>((_, reject) =>
      setTimeout(() => reject(new Error(`TOOL_TIMEOUT after ${spec.timeoutSeconds}s`)), spec.timeoutSeconds * 1000),
    );
    try {
      return await Promise.race([spec.handler(ctx, input), timeout]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "TOOL_FAILED";
      // Honest failure — never fabricate success.
      return { ok: false, error: message.slice(0, 300) };
    }
  }
}

/** Process-wide singleton used by the AI gateway and Agent runtime. */
export const toolRegistry = new ToolRegistry();
