// =============================================================================
// Cloudflare free-tier quota (src/lib/ai/cloudflare-quota.ts).
//
// The Firebase admin layer is faked with an in-memory store, the Cloudflare
// analytics endpoint is faked at fetch — no network, no credentials. The
// suite pins the accounting contract:
//   • UTC day keys and the 00:00 UTC reset;
//   • request counts recorded per attempt;
//   • actual Neuron usage when Cloudflare reports it (GraphQL or response),
//     never a token-based estimate;
//   • stop-the-request exhaustion with a typed, fallback-eligible error;
//   • the safety reserve, the request-budget safety net when Neurons cannot
//     be read, and the API token never leaking into any report.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    adminConfigured: vi.fn(() => true),
    reset() {
      docs.clear();
    },
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminConfigured: store.adminConfigured,
  adminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const key = `${name}/${id}`;
          return { exists: store.docs.has(key), data: () => store.docs.get(key) };
        },
        set: async (data: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          store.docs.set(key, { ...(store.docs.get(key) ?? {}), ...data });
        },
      }),
    }),
  }),
}));

import {
  DEFAULT_DAILY_NEURON_BUDGET,
  DEFAULT_DAILY_REQUEST_BUDGET,
  DEFAULT_SAFETY_RESERVE,
  assertCloudflareQuota,
  cloudflareQuotaConfig,
  getCloudflareUsage,
  markCloudflareQuotaExhausted,
  msUntilUtcMidnight,
  recordCloudflareRequest,
  resetCloudflareQuotaForTests,
  utcDateString,
} from "@/lib/ai/cloudflare-quota";
import { AIProviderError } from "@/lib/ai/provider-error";

const CREDENTIALS = {
  accountId: "acct-0123456789abcdef",
  apiToken: "secret-cloudflare-token-XYZ",
};

const originalEnv = { ...process.env };

function stubFetch(handler: (url: string) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetCloudflareQuotaForTests();
  store.reset();
  store.adminConfigured.mockReturnValue(true);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLOUDFLARE_")) delete process.env[key];
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLOUDFLARE_") && !(key in originalEnv)) delete process.env[key];
  }
});

describe("UTC day accounting", () => {
  it("keys the usage document by UTC date and resets at 00:00 UTC", () => {
    expect(utcDateString(new Date("2026-11-16T23:59:59Z"))).toBe("2026-11-16");
    expect(utcDateString(new Date("2026-11-17T00:00:00Z"))).toBe("2026-11-17");

    const next = msUntilUtcMidnight(new Date("2026-11-16T23:00:00Z"));
    expect(next).toBe(3_600_000); // exactly one hour to the UTC reset
    const alreadyPast = msUntilUtcMidnight(new Date("2026-11-17T00:00:00Z"));
    expect(alreadyPast).toBe(24 * 3_600_000);
  });

  it("reports the budget defaults and honours env overrides", () => {
    const defaults = cloudflareQuotaConfig({});
    expect(defaults.configured).toBe(false);
    expect(defaults.budget).toBe(DEFAULT_DAILY_NEURON_BUDGET);
    expect(defaults.safetyReserve).toBe(DEFAULT_SAFETY_RESERVE);
    expect(defaults.effectiveBudget).toBe(DEFAULT_DAILY_NEURON_BUDGET - DEFAULT_SAFETY_RESERVE);
    expect(defaults.requestBudget).toBe(DEFAULT_DAILY_REQUEST_BUDGET);

    const custom = cloudflareQuotaConfig({
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_DAILY_NEURON_BUDGET: "5000",
      CLOUDFLARE_NEURON_SAFETY_RESERVE: "1000",
      CLOUDFLARE_DAILY_REQUEST_BUDGET: "50",
    });
    expect(custom.configured).toBe(true);
    expect(custom.effectiveBudget).toBe(4_000);
    expect(custom.requestBudget).toBe(50);
  });
});

describe("recording and reading usage", () => {
  it("counts every attempt per UTC day", async () => {
    await recordCloudflareRequest({ ok: true });
    await recordCloudflareRequest({ ok: true });
    await recordCloudflareRequest({ ok: false });

    const usage = await getCloudflareUsage({ refresh: true });
    expect(usage.configured).toBe(false); // no credentials in env in this test
    expect(usage.date).toBe(utcDateString());
    expect(usage.requests).toBe(3);
    expect(usage.failedRequests).toBe(1);
  });

  it("reads actual Neurons from Cloudflare analytics (never estimates)", async () => {
    const fetchMock = stubFetch(() =>
      new Response(
        JSON.stringify({
          data: { viewer: { accounts: [{ workersAiModelsAdaptiveGroups: [{ sum: { neurons: 4321 } }] }] } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await recordCloudflareRequest({ ok: true, neurons: 200 });
    const usage = await getCloudflareUsage({ ...CREDENTIALS, refresh: true });

    expect(usage.neurons).toBe(4321);
    expect(usage.neuronsSource).toBe("graphql");
    expect(usage.remainingNeurons).toBe(9_500 - 4321); // effective budget = budget − reserve
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CREDENTIALS.apiToken}`);
    // No token anywhere in the report the admin panel receives.
    expect(JSON.stringify(usage)).not.toContain(CREDENTIALS.apiToken);
  });

  it("falls back to response-reported Neurons when analytics are unreadable", async () => {
    stubFetch(() => new Response(JSON.stringify({ errors: [{ message: "query not allowed" }] }), { status: 200 }));

    await recordCloudflareRequest({ ok: true, neurons: 600 });
    const usage = await getCloudflareUsage({ ...CREDENTIALS, refresh: true });

    expect(usage.neurons).toBe(600);
    expect(usage.neuronsSource).toBe("response");
    expect(usage.remainingNeurons).toBe(9_500 - 600);
  });

  it("reports 'unavailable' rather than fabricating Neuron numbers", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    stubFetch(() => new Response("nope", { status: 500 }));

    await recordCloudflareRequest({ ok: true });
    const usage = await getCloudflareUsage({ ...CREDENTIALS, refresh: true });

    expect(usage.neurons).toBeNull();
    expect(usage.neuronsSource).toBe("unavailable");
    expect(usage.warning).toMatch(/request safety budget/i);
  });
});

describe("exhaustion stops requests", () => {
  it("marks exhaustion from Cloudflare's own 429 neuron message and the gate throws", async () => {
    const { isCloudflareQuotaExhausted } = await import("@/lib/ai/cloudflare");
    expect(isCloudflareQuotaExhausted(429, "You have exceeded your daily neuron usage limit")).toBe(true);

    markCloudflareQuotaExhausted();
    const error = await assertCloudflareQuota("@cf/zai-org/glm-4.7-flash", CREDENTIALS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).code).toBe("CLOUDFLARE_QUOTA_EXHAUSTED");
    expect((error as AIProviderError).type).toBe("rate_limit"); // fallback-eligible, session preserved
    expect((error as AIProviderError).retryAt).toBeGreaterThan(Date.now());
  });

  it("blocks new requests once actual Neurons reach the effective budget", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersAiModelsAdaptiveGroups: [{ sum: { neurons: 9_500 } }] }] } } }), {
        status: 200,
      }),
    );
    const error = await assertCloudflareQuota("@cf/zai-org/glm-4.7-flash", CREDENTIALS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).code).toBe("CLOUDFLARE_QUOTA_EXHAUSTED");
  });

  it("uses the request budget as the safety net when Neurons cannot be read", async () => {
    process.env.CLOUDFLARE_DAILY_REQUEST_BUDGET = "3";
    stubFetch(() => new Response("unavailable", { status: 500 }));

    await recordCloudflareRequest({ ok: true });
    await recordCloudflareRequest({ ok: true });
    await expect(assertCloudflareQuota("@cf/zai-org/glm-4.7-flash", CREDENTIALS)).resolves.toBeUndefined();

    await recordCloudflareRequest({ ok: true }); // 3rd of 3
    const error = await assertCloudflareQuota("@cf/zai-org/glm-4.7-flash", CREDENTIALS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).code).toBe("CLOUDFLARE_QUOTA_EXHAUSTED");
  });

  it("a few failed attempts never exhaust the budget (failures are counted as attempts)", async () => {
    stubFetch(() => new Response("unavailable", { status: 500 }));
    for (let i = 0; i < 5; i += 1) await recordCloudflareRequest({ ok: false });
    await expect(assertCloudflareQuota("@cf/zai-org/glm-4.7-flash", CREDENTIALS)).resolves.toBeUndefined();
  });

  it("is a no-op when Cloudflare is not configured at all", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    await expect(assertCloudflareQuota("@cf/zai-org/glm-4.7-flash")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled(); // nothing is read without credentials
  });

  it("runs from the server only: the quota module carries no client code", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync("src/lib/ai/cloudflare-quota.ts", "utf8"));
    expect(source).toContain('import "server-only"');
    const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/localStorage|sessionStorage|window\.document/);
    // Exhaustion is resolved strictly inside this module — there is no path
    // that changes the Cloudflare plan or asks for paid billing.
    expect(source).not.toMatch(/upgradeUrl|createSubscription|enterBilling|startCheckout/i);
  });
});
