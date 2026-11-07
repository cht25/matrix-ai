// =============================================================================
// MATRIX AI — real, one-time tool approval records.
//
// A non-empty approval string is NOT authority. Medium+ risk tools require a
// server-created record that the owner explicitly approved, bound to the exact
// tool + argument hash, unexpired, and consumed atomically on use.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { toolRegistry, requiresApproval } from "@/lib/ai/tools/registry";

const COLLECTION = "tool_approvals";
const TTL_MS = 10 * 60_000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function approvalArgsHash(args: unknown): string {
  return crypto.createHash("sha256").update(canonical(args ?? {})).digest("hex");
}

export async function requestToolApproval(d: Db, user: SessionUser, input: { tool_id: string; args?: unknown }) {
  const spec = toolRegistry.get(input.tool_id);
  if (!spec) throw new RpcError("UNKNOWN_TOOL", 404);
  if (!requiresApproval(spec.risk, spec.approvalRequired)) throw new RpcError("APPROVAL_NOT_REQUIRED", 400);
  const ref = d.collection(COLLECTION).doc();
  const now = Date.now();
  await ref.set({
    user_id: user.uid,
    tool_id: spec.id,
    risk: spec.risk,
    args_hash: approvalArgsHash(input.args ?? {}),
    status: "pending",
    created_at: nowTs(),
    decided_at: null,
    used_at: null,
    expires_at: now + TTL_MS,
  });
  return { id: ref.id, tool_id: spec.id, status: "pending", expires_at: now + TTL_MS };
}

export async function decideToolApproval(d: Db, user: SessionUser, approvalId: string, approve: boolean) {
  return d.runTransaction(async (tx) => {
    const ref = d.collection(COLLECTION).doc(approvalId);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
    const data = snap.data()!;
    if (data.status !== "pending") throw new RpcError("APPROVAL_CLOSED", 409);
    if (Number(data.expires_at ?? 0) < Date.now()) throw new RpcError("APPROVAL_EXPIRED", 410);
    const status = approve ? "approved" : "denied";
    tx.set(ref, { status, decided_at: nowTs() }, { merge: true });
    return { id: approvalId, status };
  });
}

/** One-time consumption. Returns false instead of throwing for invalid proofs. */
export async function consumeToolApproval(d: Db, user: SessionUser, approvalId: string, toolId: string, args: unknown): Promise<boolean> {
  if (!approvalId) return false;
  try {
    return await d.runTransaction(async (tx) => {
      const ref = d.collection(COLLECTION).doc(approvalId);
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = snap.data()!;
      if (data.user_id !== user.uid || data.tool_id !== toolId || data.status !== "approved") return false;
      if (Number(data.expires_at ?? 0) < Date.now()) return false;
      if (data.args_hash !== approvalArgsHash(args ?? {})) return false;
      tx.set(ref, { status: "used", used_at: nowTs() }, { merge: true });
      return true;
    });
  } catch {
    return false;
  }
}
