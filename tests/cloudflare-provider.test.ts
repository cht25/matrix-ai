// =============================================================================
// Cloudflare Workers AI provider (src/lib/ai/cloudflare.ts).
//
// Every upstream response is faked at the fetch boundary — no network, no
// credentials — and the suite pins the contract the gateway relies on:
//   • the official endpoint + Bearer auth, credentials server-side only;
//   • both response shapes (OpenAI-compatible and native) for chat/stream;
//   • tool calling for the Agent execution engine;
//   • honest error classification: bad account, bad token, missing
//     permission, unknown model, rate limit, free-quota exhaustion;
//   • cancellation, health probing and model listing;
//   • the API token never appears in any error the caller can see.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCloudflareQuota: vi.fn(async () => {}),
  markCloudflareQuotaExhausted: vi.fn(),
  recordCloudflareRequest: vi.fn(async () => {}),
  fetch: vi.fn(),
}));

vi.mock("@/lib/ai/cloudflare-quota", () => ({
  assertCloudflareQuota: mocks.assertCloudflareQuota,
  markCloudflareQuotaExhausted: mocks.markCloudflareQuotaExhausted,
  recordCloudflareRequest: mocks.recordCloudflareRequest,
  msUntilUtcMidnight: () => Date.now() + 6 * 60 * 60 * 1000,
  cloudflareQuotaConfig: () => ({
    configured: true,
    budget: 10_000,
    safetyReserve: 500,
    effectiveBudget: 9_500,
    requestBudget: 400,
  }),
}));

import {
  CloudflareProvider,
  cloudflareConfigured,
  cloudflareCredentials,
  isCloudflareQuotaExhausted,
  listCloudflareModels,
} from "@/lib/ai/cloudflare";
import { AIProviderError } from "@/lib/ai/provider-error";
import { CLOUDFLARE_MODEL_ID } from "@/lib/ai/models/registry";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "acct-0123456789abcdef",
  CLOUDFLARE_API_TOKEN: "secret-cloudflare-token-XYZ",
};

function makeProvider(overrides: Record<string, string | undefined> = {}): CloudflareProvider {
  const credentials = cloudflareCredentials({ ...ENV, ...overrides });
  if (!credentials) throw new Error("expected credentials");
  return new CloudflareProvider(credentials);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(events: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

const REQUEST = {
  model: CLOUDFLARE_MODEL_ID,
  messages: [{ role: "user" as const, content: "hello" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertCloudflareQuota.mockResolvedValue(undefined);
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configuration (backend env only)", () => {
  it("is null without the account id or token, and rejects placeholders", () => {
    expect(cloudflareCredentials({})).toBeNull();
    expect(cloudflareCredentials({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "" })).toBeNull();
    expect(cloudflareCredentials({ CLOUDFLARE_ACCOUNT_ID: "YOUR-ACCOUNT", CLOUDFLARE_API_TOKEN: "tok" })).toBeNull();
    expect(cloudflareCredentials({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "sk_..." })).toBeNull();
    expect(cloudflareConfigured({})).toBe(false);
    expect(cloudflareConfigured(ENV)).toBe(true);
  });

  it("defaults the model to the exact catalog id and honours CLOUDFLARE_DEFAULT_MODEL", () => {
    expect(cloudflareCredentials(ENV)?.model).toBe(CLOUDFLARE_MODEL_ID);
    expect(cloudflareCredentials({ ...ENV, CLOUDFLARE_DEFAULT_MODEL: "@cf/meta/llama-3.1-8b-instruct" })?.model).toBe(
      "@cf/meta/llama-3.1-8b-instruct",
    );
  });

  it("never exposes the token through the form the logs emit", async () => {
    const { redactedConfig } = await import("@/lib/ai/cloudflare");
    const credentials = cloudflareCredentials(ENV)!;
    expect(JSON.stringify(credentials)).toContain(ENV.CLOUDFLARE_API_TOKEN); // the client needs it…
    expect(JSON.stringify(redactedConfig(credentials))).not.toContain(ENV.CLOUDFLARE_API_TOKEN); // …but logs never get it
    expect(JSON.stringify(redactedConfig(credentials))).toContain("acct…cdef");
  });
});

describe("successful requests", () => {
  it("posts to the official endpoint with Bearer auth and parses the native shape", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ success: true, result: { response: "Hi there", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } }),
    );
    const client = makeProvider();
    const response = await client.chat({ ...REQUEST });
    expect(response.content).toBe("Hi there");
    expect(response.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });

    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_MODEL_ID}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ENV.CLOUDFLARE_API_TOKEN}`);
    const body = JSON.parse(String(init.body)) as { messages: unknown[]; stream: boolean };
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    // The request was recorded for quota accounting.
    expect(mocks.recordCloudflareRequest).toHaveBeenCalledWith(expect.objectContaining({ ok: true, model: CLOUDFLARE_MODEL_ID }));
  });

  it("parses the OpenAI-compatible shape including tool calls for Agent mode", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({
        success: true,
        result: {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      }),
    );
    const client = makeProvider();
    const response = await client.chat({ ...REQUEST, tools: [{ type: "function", function: { name: "write_file", description: "", parameters: {} } }] });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0].function.name).toBe("write_file");
    expect(response.finishReason).toBe("tool_calls");
    // Tools travel with the request the Agent executor sends.
    const body = JSON.parse(String((mocks.fetch.mock.calls[0][1] as RequestInit).body)) as { tools?: unknown[]; tool_choice?: string };
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
  });

  it("streams OpenAI-style SSE chunks up to [DONE]", async () => {
    mocks.fetch.mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    const client = makeProvider();
    let text = "";
    for await (const delta of client.streamChat({ ...REQUEST })) text += delta;
    expect(text).toBe("Hello");
  });

  it("streams the native {response} chunk style as well", async () => {
    mocks.fetch.mockResolvedValue(
      sseResponse([`data: ${JSON.stringify({ response: "part-1 " })}\n\n`, `data: ${JSON.stringify({ response: "part-2" })}\n\n`]),
    );
    const client = makeProvider();
    let text = "";
    for await (const delta of client.streamChat({ ...REQUEST })) text += delta;
    expect(text).toBe("part-1 part-2");
  });

  it("honours request cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) => {
      if (init.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return Promise.reject(new Error("should not be reached"));
    });
    const client = makeProvider();
    await expect(client.chat({ ...REQUEST, signal: controller.signal })).rejects.toThrow();
    expect(mocks.assertCloudflareQuota).toHaveBeenCalled();
  });
});

describe("error classification", () => {
  it("classifies an invalid API token as an authentication failure", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401));
    const client = makeProvider();
    const error = await client.chat({ ...REQUEST }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).type).toBe("authentication");
    expect((error as AIProviderError).status).toBe(401);
  });

  it("classifies an invalid account id distinctly from an unknown model", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ success: false, errors: [{ code: 7003, message: "Could not route to account" }] }, 404));
    const client = makeProvider();
    const error = (await client.chat({ ...REQUEST }).catch((e: unknown) => e)) as AIProviderError;
    expect(error.type).toBe("invalid_request");
    expect(error.code).toBe("INVALID_ACCOUNT_ID");
    expect(error.modelUnavailable).toBe(false);
  });

  it("flags a genuinely unknown model as modelUnavailable", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ success: false, errors: [{ code: 5000, message: "model not found for api version" }] }, 404));
    const client = makeProvider();
    const error = (await client.chat({ ...REQUEST }).catch((e: unknown) => e)) as AIProviderError;
    expect(error.modelUnavailable).toBe(true);
  });

  it("classifies a missing-permission token as authentication, not quota", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ success: false, errors: [{ code: 9109, message: "permission denied: missing Workers AI edit scope" }] }, 403),
    );
    const client = makeProvider();
    const error = (await client.chat({ ...REQUEST }).catch((e: unknown) => e)) as AIProviderError;
    expect(error.type).toBe("authentication");
    expect(error.code).not.toBe("CLOUDFLARE_QUOTA_EXHAUSTED");
  });

  it("recognises free-quota exhaustion, marks it and stops the account", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ success: false, errors: [{ code: 429, message: "You have exceeded your daily neuron usage limit" }] }, 429),
    );
    const client = makeProvider();
    const error = (await client.chat({ ...REQUEST }).catch((e: unknown) => e)) as AIProviderError;
    expect(error.code).toBe("CLOUDFLARE_QUOTA_EXHAUSTED");
    expect(error.type).toBe("rate_limit"); // fallback-eligible for the gateway
    expect(error.retryAt).toBeGreaterThan(Date.now());
    expect(mocks.markCloudflareQuotaExhausted).toHaveBeenCalled();
    expect(mocks.recordCloudflareRequest).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it("classifies plain rate limits as rate_limit without the quota code", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ success: false, errors: [{ code: 429, message: "Too many requests" }] }, 429));
    const client = makeProvider();
    const error = (await client.chat({ ...REQUEST }).catch((e: unknown) => e)) as AIProviderError;
    expect(error.type).toBe("rate_limit");
    expect(error.code).not.toBe("CLOUDFLARE_QUOTA_EXHAUSTED");
  });

  it("keeps the API token out of every error the caller can see", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(`Bearer ${ENV.CLOUDFLARE_API_TOKEN} rejected`, { status: 401 }),
    );
    const client = makeProvider();
    const error = (await client.chat({ ...REQUEST }).catch((e: unknown) => e)) as AIProviderError;
    expect(error.detail).not.toContain(ENV.CLOUDFLARE_API_TOKEN);
    expect(error.message).not.toContain(ENV.CLOUDFLARE_API_TOKEN);
  });

  it("refuses to send anything when the quota gate says the day is exhausted", async () => {
    mocks.assertCloudflareQuota.mockRejectedValue(
      new AIProviderError({
        provider: "Cloudflare",
        model: CLOUDFLARE_MODEL_ID,
        type: "rate_limit",
        code: "CLOUDFLARE_QUOTA_EXHAUSTED",
        detail: "exhausted",
      }),
    );
    const client = makeProvider();
    const error = (await client.chat({ ...REQUEST }).catch((e: unknown) => e)) as AIProviderError;
    expect(error.code).toBe("CLOUDFLARE_QUOTA_EXHAUSTED");
    expect(mocks.fetch).not.toHaveBeenCalled(); // no request was sent
  });

  it("quota detector: neuron/usage messages on 429 are quota, permissions are not", () => {
    expect(isCloudflareQuotaExhausted(429, "daily quota exceeded: neuron usage limit")).toBe(true);
    expect(isCloudflareQuotaExhausted(403, "You have used all your included neurons")).toBe(true);
    expect(isCloudflareQuotaExhausted(403, "permission denied for this scope")).toBe(false);
    expect(isCloudflareQuotaExhausted(500, "internal error")).toBe(false);
  });
});

describe("health and catalog", () => {
  it("health check probes the model list (no inference spend) and reports honestly", async () => {
    const client = makeProvider();
    mocks.fetch.mockResolvedValue(jsonResponse({ result: [] }, 200));
    await expect(client.healthCheck()).resolves.toBe(true);

    mocks.fetch.mockResolvedValue(jsonResponse({ errors: [{ message: "Authentication error" }] }, 401));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(client.healthCheck()).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    // The structured failure never contains the token.
    const record = JSON.stringify(errorSpy.mock.calls[0][1] ?? {});
    expect(record).not.toContain(ENV.CLOUDFLARE_API_TOKEN);
    errorSpy.mockRestore();
  });

  it("lists the account's model ids from the official catalog endpoint", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ result: [{ id: CLOUDFLARE_MODEL_ID, name: "GLM 4.7 Flash" }, { id: "@cf/meta/llama-3.1-8b-instruct" }] }),
    );
    const models = await listCloudflareModels(cloudflareCredentials(ENV)!);
    expect(models.map((model) => model.id)).toContain(CLOUDFLARE_MODEL_ID);
    const [url] = mocks.fetch.mock.calls[0] as [string];
    expect(url).toContain(`/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/ai/models/search`);
  });

  it("surfaces a failing catalog read as an error instead of an empty list", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ errors: [{ message: "Authentication error" }] }, 401));
    await expect(listCloudflareModels(cloudflareCredentials(ENV)!)).rejects.toThrow(/model list failed \(401\)/);
  });
});
