// =============================================================================
// MATRIX AI — Vercel deployment engine (server-only).
//
// All calls go to the real Vercel REST API with the server-side token
// (VERCEL_TOKEN, optional VERCEL_TEAM_ID). The token NEVER reaches the
// browser. When the token is not configured every function fails honestly
// with VERCEL_NOT_CONFIGURED — nothing is mocked.
//
// Custom-domain strategy: deployments are attached to subdomains of the
// approved parent domain (default apps.thamjj13.top, VERCEL_APPS_DOMAIN).
// A wildcard DNS record alone cannot attach a deployment — the domain must
// be added/verified on the team and then assigned to the project, which is
// exactly what addProjectDomain/assignDeploymentDomain do here.
// =============================================================================

import "server-only";
import { vercelConfig, isVercelConfigured } from "@/lib/env";
import { RpcError } from "@/lib/server/rpc";

export { RpcError };

const API = "https://api.vercel.com";

export type VercelProject = {
  id: string;
  name: string;
  framework: string | null;
  link: { type: string; repo?: string } | null;
  latestDeployments: Array<{ url: string; state: string }>;
};

export type VercelDeployment = {
  id: string;
  url: string;
  state: string;
  readyState: string;
  createdAt: number;
  alias: string[];
  target: string | null;
};

type FetchLike = typeof fetch;

function requireConfig(): { token: string; teamId: string } {
  if (!isVercelConfigured()) throw new RpcError("VERCEL_NOT_CONFIGURED", 503);
  const v = vercelConfig();
  return { token: v.token, teamId: v.teamId };
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; fetchImpl?: FetchLike } = {},
): Promise<T> {
  const { token, teamId } = requireConfig();
  const url = new URL(`${API}${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const res = await (init.fetchImpl ?? fetch)(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: { message: text.slice(0, 200) } };
  }
  if (!res.ok) {
    const message = ((json.error as { message?: string } | undefined)?.message) ?? `HTTP_${res.status}`;
    // Surface rate limits honestly.
    if (res.status === 429) throw new RpcError("VERCEL_RATE_LIMITED", 429);
    throw new RpcError(`VERCEL_ERROR: ${message}`.slice(0, 180), res.status === 401 || res.status === 403 ? 502 : 502);
  }
  return json as T;
}

/** List projects the token/team can access. */
export async function listVercelProjects(fetchImpl?: FetchLike): Promise<VercelProject[]> {
  const data = await api<{ projects?: Array<Record<string, unknown>> }>("/v9/projects", { fetchImpl });
  return (data.projects ?? []).map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    framework: (p.framework as string | null) ?? null,
    link: (p.link as VercelProject["link"]) ?? null,
    latestDeployments: Array.isArray(p.latestDeployments)
      ? (p.latestDeployments as Array<Record<string, unknown>>).map((d) => ({ url: String(d.url ?? ""), state: String(d.state ?? "") }))
      : [],
  }));
}

export async function getVercelProject(projectId: string, fetchImpl?: FetchLike): Promise<VercelProject> {
  const p = await api<Record<string, unknown>>(`/v9/projects/${encodeURIComponent(projectId)}`, { fetchImpl });
  return {
    id: String(p.id ?? projectId),
    name: String(p.name ?? ""),
    framework: (p.framework as string | null) ?? null,
    link: (p.link as VercelProject["link"]) ?? null,
    latestDeployments: [],
  };
}

/** Create a production deployment for a project from its linked git source. */
export async function createVercelDeployment(
  projectId: string,
  input: { name?: string; target?: "production" | "preview"; gitSource?: { type: "github"; repo: string; ref: string } },
  fetchImpl?: FetchLike,
): Promise<VercelDeployment> {
  const body: Record<string, unknown> = {
    name: input.name ?? projectId,
    target: input.target ?? "production",
    projectId,
  };
  if (input.gitSource) body.gitSource = input.gitSource;
  const d = await api<Record<string, unknown>>(`/v13/deployments`, { method: "POST", body, fetchImpl });
  return normalizeDeployment(d);
}

export async function getVercelDeployment(deploymentId: string, fetchImpl?: FetchLike): Promise<VercelDeployment> {
  const d = await api<Record<string, unknown>>(`/v13/deployments/${encodeURIComponent(deploymentId)}`, { fetchImpl });
  return normalizeDeployment(d);
}

/** Poll a deployment until it reaches a terminal state (bounded). */
export async function waitForDeployment(
  deploymentId: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: FetchLike } = {},
): Promise<VercelDeployment> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dep = await getVercelDeployment(deploymentId, opts.fetchImpl);
    if (["READY", "ERROR", "CANCELED"].includes(dep.readyState)) return dep;
    if (Date.now() > deadline) throw new RpcError("VERCEL_DEPLOY_TIMEOUT", 504);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** List the team's verified domains (e.g. apps.thamjj13.top). */
export async function listVercelDomains(fetchImpl?: FetchLike): Promise<Array<{ name: string; verified: boolean }>> {
  const data = await api<{ domains?: Array<Record<string, unknown>> }>("/v9/domains", { fetchImpl });
  return (data.domains ?? []).map((d) => ({ name: String(d.name ?? ""), verified: d.verified === true }));
}

/**
 * Attach a custom subdomain (portfolio.apps.thamjj13.top) to a project.
 * The parent domain must already be added+verified on the Vercel team —
 * a wildcard DNS record alone is NOT sufficient, which is why this call
 * exists.
 */
export async function addProjectDomain(
  projectId: string,
  domain: string,
  fetchImpl?: FetchLike,
): Promise<{ name: string; verified: boolean }> {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) throw new RpcError("DOMAIN_INVALID");
  const parent = vercelConfig().appsDomain;
  if (!domain.endsWith(`.${parent}`) && domain !== parent) {
    throw new RpcError("DOMAIN_NOT_UNDER_APPROVED_PARENT", 400);
  }
  const d = await api<Record<string, unknown>>(`/v10/projects/${encodeURIComponent(projectId)}/domains`, {
    method: "POST",
    body: { name: domain },
    fetchImpl,
  });
  return { name: String(d.name ?? domain), verified: d.verified === true };
}

/** Assign a ready deployment to a domain alias. */
export async function assignDeploymentAlias(
  deploymentId: string,
  alias: string,
  fetchImpl?: FetchLike,
): Promise<{ alias: string }> {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(alias)) throw new RpcError("DOMAIN_INVALID");
  const d = await api<Record<string, unknown>>(`/v13/deployments/${encodeURIComponent(deploymentId)}/aliases`, {
    method: "POST",
    body: { alias },
    fetchImpl,
  });
  return { alias: String(d.alias ?? alias) };
}

function normalizeDeployment(d: Record<string, unknown>): VercelDeployment {
  const alias = Array.isArray(d.alias) ? (d.alias as unknown[]).map(String) : [];
  const url = String(d.url ?? "");
  return {
    id: String(d.id ?? ""),
    url: url ? (url.startsWith("http") ? url : `https://${url}`) : "",
    state: String(d.state ?? ""),
    readyState: String(d.readyState ?? d.state ?? ""),
    createdAt: Number(d.createdAt ?? 0),
    alias,
    target: (d.target as string | null) ?? null,
  };
}
