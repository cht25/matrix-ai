import { afterEach, describe, expect, it, vi } from "vitest";
import { createAIRoutesFromDb } from "../src/lib/ai/config";
import { createRuntimeAIRoute } from "../src/lib/ai/runtime-config";
import { normalizeCompatibleBaseUrl } from "../src/lib/ai/openai";

const ORIGINAL = { ...process.env };

function fakeDb(config: Record<string, unknown> | null) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => (config ? { exists: true, data: () => config } : { exists: false }),
      }),
    }),
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("admin-configured OpenAI provider routing", () => {
  it("uses the saved endpoint/model as the primary route", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const db = fakeDb({
      enabled: true,
      base_url: "https://provider.example/v1",
      model: "gpt-4o-mini",
      api_key: "sk-real-key",
    }) as never;

    const targets = await createAIRoutesFromDb(db, false);
    expect(targets).toHaveLength(1);
    expect(targets[0].provider).toBe("OpenAI");
    expect(targets[0].model).toBe("gpt-4o-mini");
    expect(targets[0].client.healthCheck).toBeDefined();
  });

  it("falls back to environment routes when no admin config is saved", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const targets = await createAIRoutesFromDb(null, false);
    expect(targets).toHaveLength(0);
  });

  it("does not create a runtime route when the provider is disabled", () => {
    const route = createRuntimeAIRoute({
      enabled: false,
      base_url: "https://provider.example/v1",
      model: "gpt-4o-mini",
      api_key: "sk-real-key",
    });
    expect(route).toBeNull();
  });

  it("uses the dedicated Agent/coding model for coding routes when one is saved", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const db = fakeDb({
      enabled: true,
      base_url: "https://provider.example/v1",
      model: "gpt-4o-mini",
      agent_model: "qwen/qwen3-coder",
      api_key: "sk-real-key",
    }) as never;

    const chatTargets = await createAIRoutesFromDb(db, false);
    expect(chatTargets[0].model).toBe("gpt-4o-mini");

    const agentTargets = await createAIRoutesFromDb(db, true);
    expect(agentTargets[0].model).toBe("qwen/qwen3-coder");
  });

  it("falls back to the chat model for coding when no Agent model is set", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const db = fakeDb({
      enabled: true,
      base_url: "https://provider.example/v1",
      model: "gpt-4.1-mini",
      api_key: "sk-real-key",
    }) as never;

    const agentTargets = await createAIRoutesFromDb(db, true);
    expect(agentTargets[0].model).toBe("gpt-4.1-mini");
  });
});

describe("runtime provider normalization", () => {
  it("normalizes a full chat completions endpoint for storage", () => {
    expect(normalizeCompatibleBaseUrl("https://provider.example/v1/chat/completions"))
      .toBe("https://provider.example/v1");
  });
});
