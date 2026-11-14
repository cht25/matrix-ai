import { afterEach, describe, expect, it } from "vitest";
import { completeWithFallback, nextRouteIndex } from "@/lib/ai/executor";
import { AIProviderError, glmBusinessErrorType, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { modelFamily, rankModelRoutes, reportModelResult, resetRoutingHealth } from "@/lib/ai/model-routing";
import type { AIProvider } from "@/lib/ai/groq";
import type { AIRouteTarget } from "@/lib/ai/config";

function client(result: string | AIProviderError, calls: string[] = [], label = ""): AIProvider {
  return {
    supportsToolCalls: true,
    healthCheck: async () => true,
    async chat() { calls.push(label); if (result instanceof AIProviderError) throw result; return { content: result }; },
  } as unknown as AIProvider;
}
const route = (provider: AIRouteTarget["provider"], model: string, c: AIProvider, extra: Partial<AIRouteTarget> = {}): AIRouteTarget => ({ provider, model, client: c, providerId: provider.toLowerCase(), ...extra });
const glmError = (status: number, body: unknown) => providerErrorFromResponse("GLM", "glm-5-turbo", new Response(JSON.stringify(body), { status }), JSON.stringify(body));

afterEach(() => resetRoutingHealth());

describe("GLM error classification", () => {
  it("maps numeric business codes to real causes", () => {
    expect(glmBusinessErrorType("1113")?.type).toBe("billing");
    expect(glmBusinessErrorType("1211")).toMatchObject({ modelUnavailable: true });
    expect(glmBusinessErrorType("1302")?.type).toBe("rate_limit");
    expect(glmBusinessErrorType("1002")?.type).toBe("authentication");
    expect(glmBusinessErrorType("9999")).toBeNull();
  });

  it("treats 'model does not exist' as model-unavailable, not a malformed request", () => {
    const error = glmError(400, { error: { code: "1211", message: "模型不存在，请检查模型代码。" } });
    expect(error.modelUnavailable).toBe(true);
    expect(error.fallbackEligible).toBe(true);
    expect(error.code).toBe("1211");
  });

  it("never leaks the API key in diagnostics", () => {
    const error = glmError(401, { error: { code: "1002", message: "Authorization Token invalid: Bearer abcdef1234567890abcdef1234567890.zzzzzzzzzzzz" } });
    expect(error.type).toBe("authentication");
    expect(error.detail).not.toContain("abcdef1234567890abcdef1234567890");
  });
});

describe("automatic model fallback", () => {
  it("orders the Agent chain GLM, then Gemini, then GPT OSS", () => {
    const ok = client("ok");
    const ranked = rankModelRoutes([
      route("Groq", "openai/gpt-oss-120b", ok, { catalog: "listed" }),
      route("Gemini", "gemini-3-pro", ok, { catalog: "listed" }),
      route("GLM", "glm-5-turbo", ok, { catalog: "listed" }),
    ], "agent");
    expect(ranked.map((r) => modelFamily(r))).toEqual(["glm", "gemini", "gpt-oss"]);
  });

  it("demotes a model the provider catalogue does not list", () => {
    const ok = client("ok");
    const ranked = rankModelRoutes([
      route("GLM", "glm-5-turbo", ok, { catalog: "missing" }),
      route("Gemini", "gemini-3-pro", ok, { catalog: "listed" }),
    ], "agent");
    expect(ranked[0].provider).toBe("Gemini");
  });

  it("demotes a model that just failed, then restores nothing silently", () => {
    const ok = client("ok");
    const glm = route("GLM", "glm-5-turbo", ok, { catalog: "listed" });
    const gemini = route("Gemini", "gemini-3-pro", ok, { catalog: "listed" });
    reportModelResult(glm, 100, new AIProviderError({ provider: "GLM", model: "glm-5-turbo", status: 401, type: "authentication", detail: "bad key" }));
    expect(rankModelRoutes([glm, gemini], "agent")[0].provider).toBe("Gemini");
  });

  it("skips every model on the same account after an auth failure", () => {
    const ok = client("ok");
    const targets = [route("GLM", "glm-5-turbo", ok), route("GLM", "glm-4.7", ok), route("Gemini", "gemini-3-pro", ok)];
    const auth = new AIProviderError({ provider: "GLM", model: "glm-5-turbo", status: 401, type: "authentication", detail: "bad key" });
    expect(nextRouteIndex(targets, 0, auth)).toBe(2);
    const missing = new AIProviderError({ provider: "GLM", model: "glm-5-turbo", status: 400, type: "invalid_request", detail: "no such model", modelUnavailable: true, fallbackEligible: true });
    expect(nextRouteIndex(targets, 0, missing)).toBe(1);
  });

  it("GLM auth failure → Gemini answers, and the result records the fallback", async () => {
    const calls: string[] = [];
    const targets = [
      route("GLM", "glm-5-turbo", client(new AIProviderError({ provider: "GLM", model: "glm-5-turbo", status: 401, type: "authentication", detail: "bad key" }), calls, "glm")),
      route("Gemini", "gemini-3-pro", client("built by gemini", calls, "gemini")),
      route("Groq", "openai/gpt-oss-120b", client("built by oss", calls, "oss")),
    ];
    const result = await completeWithFallback(targets, { messages: [{ role: "user", content: "build" }] });
    expect(result.response.content).toBe("built by gemini");
    expect(result.target.provider).toBe("Gemini");
    expect(result.fallback).toBe(true);
    expect(result.attempts.map((f) => f.provider)).toEqual(["GLM"]);
    expect(calls).toEqual(["glm", "gemini"]);
  });

  it("GLM and Gemini both failing → GPT OSS answers; all failing → a clear error", async () => {
    const down = (provider: "GLM" | "Gemini" | "Groq", model: string) => new AIProviderError({ provider, model, status: 503, type: "provider_unavailable", detail: "down" });
    const targets = [
      route("GLM", "glm-5-turbo", client(down("GLM", "glm-5-turbo"))),
      route("Gemini", "gemini-3-pro", client(down("Gemini", "gemini-3-pro"))),
      route("Groq", "openai/gpt-oss-120b", client("built by oss")),
    ];
    const result = await completeWithFallback(targets, { messages: [{ role: "user", content: "build" }] });
    expect(result.target.model).toBe("openai/gpt-oss-120b");
    expect(result.attempts).toHaveLength(2);
    targets[2] = route("Groq", "openai/gpt-oss-120b", client(down("Groq", "openai/gpt-oss-120b")));
    await expect(completeWithFallback(targets, { messages: [{ role: "user", content: "build" }] })).rejects.toBeInstanceOf(AIProviderError);
  }, 20_000);
});
