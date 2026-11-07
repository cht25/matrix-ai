import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentProviders } from "@/lib/ai/provider-registry";
import { GeminiProvider } from "@/lib/ai/gemini";

afterEach(() => vi.unstubAllEnvs());

describe("server-side Gemini provider registration", () => {
  it("registers native Gemini without requiring OpenRouter or guessing a model", () => {
    vi.stubEnv("GEMINI_API_KEY", "server-only-test-key");
    vi.stubEnv("GEMINI_MODEL", "catalog-selected-general");
    vi.stubEnv("GEMINI_CODING_MODEL", "catalog-selected-code");
    vi.stubEnv("GEMINI_VISION_MODEL", "catalog-selected-vision");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_CODING_MODEL", "");
    vi.stubEnv("GROQ_API_KEY", "");

    const providers = environmentProviders();
    const gemini = providers.find((entry) => entry.id === "gemini");
    expect(gemini).toMatchObject({ defaultModel: "catalog-selected-general", codingModel: "catalog-selected-code", visionModel: "catalog-selected-vision" });
    expect(gemini?.client).toBeInstanceOf(GeminiProvider);
    expect(providers.some((entry) => entry.id === "openrouter")).toBe(false);
  });

  it("does not register Gemini until a server key is configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(environmentProviders().some((entry) => entry.id === "gemini")).toBe(false);
  });
});
