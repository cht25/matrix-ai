// =============================================================================
// MATRIX AI — Agent Tool Gateway (server-only).
//
// The ONLY path from an AI/Agent request to a registered tool. For every call
// the gateway independently re-checks authorization (RBAC permissions via the
// RPC layer), enforces the risk/approval policy, executes with a timeout, and
// writes audit + security-event records. A model requesting a tool never
// bypasses this gate.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { adminDb, nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { toolRegistry, type ToolContext, type ToolResult } from "@/lib/ai/tools/registry";
import { hasPermission } from "@/lib/server/rpc";
// Side-effect import: registers all built-in tools on the singleton registry.
import "@/lib/ai/tools/index";

export { toolRegistry };

// Lightweight per-user rate limit for tool execution.
const hits = new Map<string, number[]>();
export function toolRateLimited(uid: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(uid) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) return true;
  arr.push(now);
  hits.set(uid, arr);
  return false;
}

/** Public description of a tool for the Agent Studio UI (never the handler). */
export function describeTools() {
  return toolRegistry.list().map((t) => ({
    id: t.id,
    description: t.description,
    category: t.category,
    risk: t.risk,
    requiredPermissions: [...t.requiredPermissions],
    scopes: [...t.scopes],
    environment: t.environment,
    timeoutSeconds: t.timeoutSeconds,
    approvalRequired: t.approvalRequired,
    auditRequired: t.auditRequired,
  }));
}

async function auditTool(
  d: Db,
  user: SessionUser,
  toolId: string,
  outcome: "ok" | "denied" | "error",
  detail: string,
  requestId: string,
) {
  try {
    await d.collection("audit_logs").add({
      actor_id: user.uid,
      action: `tool.${outcome}`,
      target_type: "tool",
      target_id: toolId,
      reason: detail.slice(0, 300),
      metadata: { request_id: requestId, outcome },
      created_at: nowTs(),
    });
  } catch (err) {
    console.warn("[MATRIX] tool audit write failed", err);
  }
}

/**
 * Guarded tool execution for Agent mode. Returns the registry's honest result
 * envelope; denials and failures are audited, never hidden.
 */
export async function executeAgentTool(
  d: Db,
  user: SessionUser,
  toolId: string,
  args: unknown,
  opts: { approvalId?: string; dryRun?: boolean } = {},
): Promise<ToolResult & { request_id: string }> {
  const requestId = `tool_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  if (toolRateLimited(user.uid)) {
    await auditTool(d, user, toolId, "denied", "RATE_LIMITED", requestId);
    return { ok: false, error: "RATE_LIMITED", request_id: requestId };
  }
  const spec = toolRegistry.get(toolId);
  if (!spec) {
    await auditTool(d, user, toolId, "denied", "UNKNOWN_TOOL", requestId);
    return { ok: false, error: "UNKNOWN_TOOL", request_id: requestId };
  }
  const ctx: ToolContext = {
    db: d,
    uid: user.uid,
    email: user.email,
    requestId,
    approvalId: opts.approvalId,
    dryRun: opts.dryRun ?? false,
  };
  const authorizer = async (c: ToolContext, permissions: readonly string[]) => {
    for (const p of permissions) {
      if (!(await hasPermission(d, c.uid, p))) return false;
    }
    return true;
  };
  const result = await toolRegistry.call(ctx, toolId, args, authorizer);
  if (spec.auditRequired || result.ok === false) {
    await auditTool(d, user, toolId, result.ok ? "ok" : "error", result.error ?? result.message ?? "executed", requestId);
  }
  if (!result.ok && result.error === "APPROVAL_REQUIRED") {
    try {
      await d.collection("security_events").add({
        user_id: user.uid,
        event_type: "tool_approval_required",
        detail: `Tool "${toolId}" requires explicit approval (risk: ${spec.risk})`,
        created_at: nowTs(),
      });
    } catch {
      // audit best-effort
    }
  }
  return { ...result, request_id: requestId };
}

/** Convenience handle for routes. */
export function gatewayDb(): Db {
  return adminDb();
}

/**
 * Record an Agent-mode tool selection (from the pipeline's intent detector)
 * in the audit log. Called by the AI gateway so every agent tool choice is
 * traceable — selection is logged, execution still goes through
 * executeAgentTool.
 */
export async function recordAgentToolSelection(
  d: Db,
  uid: string,
  tool: string,
  reason: string,
): Promise<void> {
  try {
    await d.collection("audit_logs").add({
      actor_id: uid,
      action: "agent.tool_selected",
      target_type: "tool",
      target_id: tool,
      reason: reason.slice(0, 300),
      metadata: { registered: toolRegistry.has(tool) },
      created_at: nowTs(),
    });
  } catch (err) {
    console.warn("[MATRIX] agent tool selection audit failed", err);
  }
}
