import { afterEach, describe, expect, it, vi } from "vitest";
import { createAIRoutesFromDb } from "@/lib/ai/config";
import { discoverAgentModels, rankModelRoutes, modelProfile, reportModelResult, resetRoutingHealth } from "@/lib/ai/model-routing";
import { preferenceForMode } from "@/lib/ai/model-preferences";
import { completeWithFallback, streamWithFallback } from "@/lib/ai/executor";
import { AIProviderError, providerErrorFromResponse } from "@/lib/ai/provider-error";
import type { AIRouteTarget } from "@/lib/ai/config";
import type { AIProvider } from "@/lib/ai/groq";

afterEach(() => { vi.unstubAllEnvs(); resetRoutingHealth(); });
function target(provider: AIRouteTarget["provider"], model: string, chat: AIProvider["chat"], tools = true): AIRouteTarget {
  return { provider, model, providerId: `${provider}-${model}`, client: { supportsToolCalls: tools, chat,
    async *streamChat() { yield "arrived"; }, healthCheck: async () => true } };
}
const ok = async () => ({ content: "real answer", model: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
const unavailable = (provider: AIRouteTarget["provider"], model: string, status: number) =>
  providerErrorFromResponse(provider, model, new Response("model not found", { status }), "model not found");

describe("independent mode policy and intelligent fallback", () => {
  it("keeps legacy explicit Chat preference, independent Agent override and reset", () => {
    const saved = { ai_provider_id: "groq", ai_model_id: "chosen", agent_ai_provider_id: "glm", agent_ai_model_id: "glm-5-turbo" };
    expect(preferenceForMode(saved, "chat")).toMatchObject({ model_id: "chosen" });
    expect(preferenceForMode(saved, "agent")).toMatchObject({ model_id: "glm-5-turbo" });
    expect(preferenceForMode({ ...saved, agent_ai_model_id: "" }, "agent").model_id).toBe("");
    expect(preferenceForMode({}, "chat").model_id).toBe("");
  });

  it("defaults normal Chat to OSS even for high-load requests; never auto-selects GLM", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai-key"); vi.stubEnv("GROQ_API_KEY", "gsk-key");
    vi.stubEnv("GLM_MODEL", ""); vi.stubEnv("GLM_CODING_MODEL", "");
    const chat = await createAIRoutesFromDb(null, false, false, "high");
    expect(chat[0]).toMatchObject({ provider: "Groq", model: "openai/gpt-oss-120b" });
    expect(chat.every((t) => t.provider !== "GLM")).toBe(true);
    const agent = await createAIRoutesFromDb(null, true);
    expect(agent[0]).toMatchObject({ provider: "GLM", model: "glm-5-turbo" });
    expect(agent.some((r) => r.provider === "Groq")).toBe(true);
  });

  it("ranks actual capabilities over registry order; filters models without tools", () => {
    const weak = target("OpenAI", "small-chat", ok, true);
    const strong = target("GLM", "glm-5-turbo", ok);
    const noTools = target("Anthropic", "claude-opus-4-1", ok, false);
    const ranked = rankModelRoutes([weak, noTools, strong], "agent");
    expect(ranked.map((r) => r.model)).toEqual(["glm-5-turbo", "small-chat"]);
    expect(modelProfile(strong)).toMatchObject({ tools: true, streaming: true, availability: "unknown" });
    reportModelResult(strong, 800, unavailable("GLM", strong.model, 404));
    expect(modelProfile(strong).availability).toBe("cooldown");
    expect(rankModelRoutes([weak, strong], "agent")[0]).toBe(weak);
  });

  it("discovers a newer capable GLM ID from the provider catalogue instead of fixing an obsolete ID", async () => {
    const provider = target("GLM", "glm-5-turbo", ok);
    provider.client.listModels = async () => [
      { id: "glm-6-turbo", label: "new", contextTokens: 200_000 },
      { id: "glm-6-vision", label: "vision" },
      { id: "glm-5-turbo", label: "current" },
    ];
    const models = await discoverAgentModels(provider.client, provider.model, "GLM", "glm");
    expect(models.some((item) => item.model === "glm-6-vision")).toBe(false);
    expect(rankModelRoutes(models, "agent")[0]).toMatchObject({ model: "glm-6-turbo", contextTokens: 200_000 });
  });

  it("advances across GLM model 404 and next model rate limit to third compatible provider", async () => {
    let calls = 0;
    const first = target("GLM", "glm-5-turbo", async () => { calls++; throw unavailable("GLM", "glm-5-turbo", 404); });
    const second = target("Groq", "openai/gpt-oss-120b", async () => { calls++; throw new AIProviderError({ provider: "Groq", model: "openai/gpt-oss-120b", type: "rate_limit", status: 429, detail: "quota" }); });
    const third = target("OpenAI", "gpt-4.1", async () => { calls++; return ok(); });
    const result = await completeWithFallback([first, second, third], { messages: [{ role: "user", content: "hi" }] });
    expect(result.target).toBe(third);
    expect(calls).toBe(3);
  });

  it("continues past credential, billing and rejected-request failures, recording each one", async () => {
    for (const [type, status] of [["authentication", 401], ["billing", 402], ["invalid_request", 400]] as const) {
      const next = vi.fn(ok);
      const first = target("GLM", "glm-5-turbo", async () => { throw new AIProviderError({ provider: "GLM", model: "glm-5-turbo", status, type, detail: "rejected" }); });
      const result = await completeWithFallback([first, target("OpenAI", "gpt-4.1", next)], { messages: [] });
      expect(next).toHaveBeenCalledTimes(1);
      expect(result.fallback).toBe(true);
      expect(result.attempts).toEqual([expect.objectContaining({ provider: "GLM", model: "glm-5-turbo", type, status })]);
      // With nothing else to try the original error is surfaced unchanged.
      await expect(completeWithFallback([first], { messages: [] })).rejects.toMatchObject({ type });
    }
    expect(providerErrorFromResponse("GLM", "glm-5-turbo", new Response("model not available", { status: 400 }), "model not available").fallbackEligible).toBe(true);
  });

  it("exhausts eligible routes with real error and never splices partial streams", async () => {
    const broken = target("GLM", "glm-5-turbo", async () => { throw unavailable("GLM", "glm-5-turbo", 404); });
    await expect(completeWithFallback([broken], { messages: [] })).rejects.toMatchObject({ status: 404 });
    const streamed = target("GLM", "glm-5-turbo", ok);
    streamed.client.streamChat = async function* () { yield "first"; throw new AIProviderError({ provider: "GLM", model: "glm-5-turbo", type: "network", detail: "lost" }); };
    const next = target("OpenAI", "gpt-4.1", ok);
    const events: string[] = [];
    await expect((async () => { for await (const value of streamWithFallback([streamed, next], { messages: [] }, () => {})) events.push(value.delta); })()).rejects.toMatchObject({ type: "network" });
    expect(events).toEqual(["first"]);
  });
});
