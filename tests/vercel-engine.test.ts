// Vercel deployment engine: real API contract exercised against a stub fetch;
// unconfigured environments fail honestly, never fabricated.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  listVercelProjects,
  createVercelDeployment,
  waitForDeployment,
  addProjectDomain,
  RpcError,
} from "@/lib/server/vercel";

const TOKEN = "test-vercel-token";

beforeEach(() => {
  process.env.VERCEL_TOKEN = TOKEN;
  process.env.VERCEL_TEAM_ID = "team_1";
  process.env.VERCEL_APPS_DOMAIN = "apps.thamjj13.top";
});
afterEach(() => {
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_APPS_DOMAIN;
});

function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; auth: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = new URL(u).pathname;
    for (const [pattern, route] of Object.entries(routes)) {
      if (path.includes(pattern)) {
        const status = route.status ?? 200;
        return new Response(JSON.stringify(route.body), { status, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("vercel engine", () => {
  it("fails honestly when the token is not configured", async () => {
    delete process.env.VERCEL_TOKEN;
    await expect(listVercelProjects()).rejects.toThrow(RpcError);
    await expect(listVercelProjects()).rejects.toMatchObject({ code: "VERCEL_NOT_CONFIGURED" });
  });

  it("lists projects with the bearer token and team id", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/v9/projects": { body: { projects: [{ id: "prj_1", name: "shop", framework: "nextjs", link: { type: "github", repo: "a/b" }, latestDeployments: [] }] } },
    });
    const projects = await listVercelProjects(fetchImpl);
    expect(projects[0]).toMatchObject({ id: "prj_1", name: "shop", framework: "nextjs" });
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).toContain("teamId=team_1");
  });

  it("creates a deployment and waits until READY", async () => {
    let n = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.includes("/v13/deployments") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "dpl_1", url: "shop-abc.vercel.app", readyState: "BUILDING", state: "BUILDING", createdAt: 1 }), { status: 200 });
      }
      if (path.includes("/v13/deployments/dpl_1")) {
        n += 1;
        const ready = n >= 2;
        return new Response(JSON.stringify({ id: "dpl_1", url: "shop-abc.vercel.app", readyState: ready ? "READY" : "BUILDING", state: ready ? "READY" : "BUILDING", createdAt: 1 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const created = await createVercelDeployment("prj_1", { target: "production" }, fetchImpl);
    expect(created.id).toBe("dpl_1");
    const final = await waitForDeployment("dpl_1", { fetchImpl, intervalMs: 1, timeoutMs: 5000 });
    expect(final.readyState).toBe("READY");
    expect(final.url).toBe("https://shop-abc.vercel.app");
  });

  it("surfaces Vercel rate limits honestly", async () => {
    const { fetchImpl } = stubFetch({ "/v9/projects": { status: 429, body: { error: { message: "rate limited" } } } });
    await expect(listVercelProjects(fetchImpl)).rejects.toMatchObject({ code: "VERCEL_RATE_LIMITED" });
  });

  it("only allows domains under the approved parent", async () => {
    const { fetchImpl } = stubFetch({});
    await expect(addProjectDomain("prj_1", "evil.example.com", fetchImpl)).rejects.toMatchObject({ code: "DOMAIN_NOT_UNDER_APPROVED_PARENT" });
    await expect(addProjectDomain("prj_1", "not a domain", fetchImpl)).rejects.toMatchObject({ code: "DOMAIN_INVALID" });
    const { fetchImpl: ok, calls } = stubFetch({ "/domains": { body: { name: "shop.apps.thamjj13.top", verified: true } } });
    const res = await addProjectDomain("prj_1", "shop.apps.thamjj13.top", ok);
    expect(res).toEqual({ name: "shop.apps.thamjj13.top", verified: true });
    expect(calls[0].url).toContain("/v10/projects/prj_1/domains");
  });
});
