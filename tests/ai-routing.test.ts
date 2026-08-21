import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithFallback } from "../src/lib/ai/executor";
import { AIProviderError, providerErrorFromResponse, sanitizeProviderDetail } from "../src/lib/ai/provider-error";
import type { AIProvider } from "../src/lib/ai/groq";
import type { AIRouteTarget } from "../src/lib/ai/config";

const originalConsoleError = console.error;
afterEach(() => {
  console.error = originalConsoleError;
});

function target(provider: "OpenRouter" | "Groq", model: string, chat: AIProvider["chat"]): AIRouteTarget {
  return {
    provider,
    model,
    client: {
      chat,
      healthCheck: async () => true,
    },
  };
}

describe("AI provider diagnostics", () => {
  it("classifies provider status and never retains a bearer token", () => {
    const response = new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad model" } }), {
      status: 400,
      headers: { "x-request-id": "or-123" },
    });
    const error = providerErrorFromResponse("OpenRouter", "nvidia/nemotron-3-ultra-550b-a55b:free", response, JSON.stringify({ error: { message: "bad model" } }));
    expect(error.type).toBe("invalid_request");
    expect(error.requestId).toBe("or-123");
    expect(sanitizeProviderDetail("Bearer sk-or-v1-secret-value")).toBe("[redacted]");
    expect(error.message).toContain("OpenRouter");
  });
});

describe("controlled AI fallback", () => {
  it("retries a transient OpenRouter failure once, then uses Groq", async () => {
    const openRouterChat = vi.fn().mockRejectedValue(new AIProviderError({
      provider: "OpenRouter",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
      status: 429,
      type: "rate_limit",
      detail: "rate limited",
    }));
    const groqChat = vi.fn().mockResolvedValue({
      content: "fallback answer",
      model: "openai/gpt-oss-120b",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    console.error = vi.fn();

    const result = await completeWithFallback(
      [
        target("OpenRouter", "nvidia/nemotron-3-ultra-550b-a55b:free", openRouterChat),
        target("Groq", "openai/gpt-oss-120b", groqChat),
      ],
      { messages: [{ role: "user", content: "build a site" }], requestId: "req-12345678" },
    );

    expect(result.response.content).toBe("fallback answer");
    expect(result.target.provider).toBe("Groq");
    expect(openRouterChat).toHaveBeenCalledTimes(2);
    expect(groqChat).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for authentication failures", async () => {
    const openRouterChat = vi.fn().mockRejectedValue(new AIProviderError({
      provider: "OpenRouter",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
      status: 401,
      type: "authentication",
      detail: "invalid key",
    }));
    const groqChat = vi.fn();
    console.error = vi.fn();

    await expect(completeWithFallback(
      [
        target("OpenRouter", "nvidia/nemotron-3-ultra-550b:free", openRouterChat),
        target("Groq", "openai/gpt-oss-120b", groqChat),
      ],
      { messages: [{ role: "user", content: "build" }] },
    )).rejects.toMatchObject({ type: "authentication" });
    expect(groqChat).not.toHaveBeenCalled();
  });
});
