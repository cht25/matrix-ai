// =============================================================================
// MATRIX AI — Agent task → Vercel deployment flow (server-only).
//
// One guarded workflow that records REAL checkpoints on the agent task while
// performing the Vercel deployment:
//   deploy_approval (explicit approve flag) → deploy → verify → report
// Every checkpoint reflects an actual outcome; failures are recorded as
// "failed" and rethrown — never marked successful.
// =============================================================================

import "server-only";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/rpc";
import { appendCheckpoint, setTaskStatus } from "@/lib/server/agent-tasks";
import { createVercelDeployment, waitForDeployment, addProjectDomain, type VercelDeployment } from "@/lib/server/vercel";

export { RpcError };

export type AgentDeployResult = {
  task_id: string;
  deployment: VercelDeployment;
  domain: { name: string; verified: boolean } | null;
};

/**
 * Deploy a MATRIX agent task to Vercel with the full checkpoint trail.
 * `approve` must be true (the user's explicit deploy approval checkpoint).
 */
export async function deployAgentTask(
  d: Db,
  user: SessionUser,
  input: {
    task_id: string;
    vercel_project_id: string;
    approve: boolean;
    target?: "production" | "preview";
    subdomain?: string; // e.g. "shop" → shop.apps.thamjj13.top
    fetchImpl?: typeof fetch;
  },
): Promise<AgentDeployResult> {
  if (!input.approve) throw new RpcError("APPROVAL_REQUIRED", 403);

  await appendCheckpoint(d, user, input.task_id, { step: "deploy_approval", state: "ok", detail: `Approved by ${user.uid}` });
  await setTaskStatus(d, user, input.task_id, "running");

  let deployment: VercelDeployment;
  try {
    await appendCheckpoint(d, user, input.task_id, { step: "deploy", state: "started", detail: `Creating Vercel deployment for ${input.vercel_project_id}` });
    deployment = await createVercelDeployment(input.vercel_project_id, { target: input.target ?? "production" }, input.fetchImpl);
    const final = await waitForDeployment(deployment.id, { fetchImpl: input.fetchImpl });
    deployment = final;
    if (final.readyState === "READY") {
      await appendCheckpoint(d, user, input.task_id, { step: "deploy", state: "ok", detail: `Deployment READY: ${final.url}` });
    } else {
      await appendCheckpoint(d, user, input.task_id, { step: "deploy", state: "failed", detail: `Deployment state ${final.readyState}` });
      await setTaskStatus(d, user, input.task_id, "failed");
      throw new RpcError(`VERCEL_DEPLOY_FAILED: ${final.readyState}`, 502);
    }
  } catch (err) {
    if (err instanceof RpcError && err.code.startsWith("VERCEL_DEPLOY_FAILED")) throw err;
    await appendCheckpoint(d, user, input.task_id, { step: "deploy", state: "failed", detail: err instanceof Error ? err.message.slice(0, 200) : "deploy failed" });
    await setTaskStatus(d, user, input.task_id, "failed");
    throw err;
  }

  // Optional approved custom domain (subdomain of the approved parent).
  let domain: AgentDeployResult["domain"] = null;
  if (input.subdomain) {
    const slug = input.subdomain.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63);
    if (!slug) throw new RpcError("DOMAIN_INVALID");
    try {
      const { vercelConfig } = await import("@/lib/env");
      domain = await addProjectDomain(input.vercel_project_id, `${slug}.${vercelConfig().appsDomain}`, input.fetchImpl);
      await appendCheckpoint(d, user, input.task_id, { step: "verify", state: domain.verified ? "ok" : "started", detail: `Domain ${domain.name} verified=${domain.verified}` });
    } catch (err) {
      await appendCheckpoint(d, user, input.task_id, { step: "verify", state: "failed", detail: err instanceof Error ? err.message.slice(0, 200) : "domain attach failed" });
      // Deployment itself succeeded; domain failure is recorded, not hidden.
    }
  }

  await appendCheckpoint(d, user, input.task_id, { step: "verify", state: "ok", detail: `Live at ${deployment.url}` });
  await appendCheckpoint(d, user, input.task_id, { step: "report", state: "ok", detail: "Deployment verified and reported" });
  await setTaskStatus(d, user, input.task_id, "completed");
  await d.collection("audit_logs").add({
    actor_id: user.uid,
    action: "agent_task.deploy",
    target_type: "agent_task",
    target_id: input.task_id,
    reason: deployment.url,
    metadata: { deployment_id: deployment.id, vercel_project_id: input.vercel_project_id },
    created_at: nowTs(),
  });
  return { task_id: input.task_id, deployment, domain };
}
