import { afterEach, describe, expect, it, vi } from "vitest";
import { createAIRoutesFromDb } from "@/lib/ai/config";
import { environmentProviders } from "@/lib/ai/provider-registry";
import { resolveGlmBaseUrl } from "@/lib/ai/glm";
import { resolveMainModelConfig } from "@/lib/ai/runtime-config";
import { getImageProviderConfigPublic } from "@/lib/ai/image/config";
import { glmImageProvider } from "@/lib/ai/image/glm-provider";
import { requiresNonStaticRuntime } from "@/lib/server/build";
import type { Db } from "@/lib/firebase/admin";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const db = (record: Record<string, unknown> | null) => ({
  collection: () => ({ doc: () => ({ get: async () => ({ exists: Boolean(record), data: () => record }) }) }),
}) as unknown as Db;

describe("Z.ai international environment integration", () => {
  it("routes chat and Agent to the same international endpoint, key and coding model", async () => {
    vi.stubEnv("GLM_API_KEY", "");
    vi.stubEnv("GLM_BASE_URL", "");
    vi.stubEnv("ZAI_API_KEY", "zai-private-key-12345");
    vi.stubEnv("GLM_MODEL", "glm-4.7");
    vi.stubEnv("GLM_CODING_MODEL", "glm-4.7-code");
    expect(resolveGlmBaseUrl()).toBe("https://api.z.ai/api/paas/v4");
    expect(environmentProviders().find((p) => p.id === "glm")?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect((await resolveMainModelConfig(null))?.base_url).toBe("https://api.z.ai/api/paas/v4");
    const calls: Array<{ url: string; headers: HeadersInit; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, headers: options.headers!, body: String(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "source files" } }] }), { status: 200 });
    }));
    for (const coding of [true]) {
      const route = (await createAIRoutesFromDb(null, coding))[0];
      expect(route.provider).toBe("GLM");
      expect(route.model).toBe("glm-5-turbo");
      await route.client.chat({ model: route.model, messages: [{ role: "user", content: "write source" }] });
    }
    const completions = calls.filter((call) => String(call.url).endsWith("/chat/completions"));
    expect(completions.map((call) => call.url)).toEqual(["https://api.z.ai/api/paas/v4/chat/completions"]);
    expect(completions.every((call) => (call.headers as Record<string, string>).Authorization === "Bearer zai-private-key-12345")).toBe(true);
    expect(completions.map((call) => JSON.parse(call.body).model)).toEqual(["glm-5-turbo"]);
    expect(await createAIRoutesFromDb(null, false)).toHaveLength(0);
    expect(calls.every((call) => !String(call.url).includes("zai-private-key"))).toBe(true);
  });

  it("normalizes explicit endpoint URLs and uses the matching image credentials", async () => {
    vi.stubEnv("GLM_API_KEY", "");
    vi.stubEnv("ZAI_API_KEY", "zai-private-image-key-12345");
    vi.stubEnv("GLM_BASE_URL", "https://api.z.ai/api/paas/v4/chat/completions");
    vi.stubEnv("GLM_IMAGE_API_KEY", "");
    expect(resolveGlmBaseUrl()).toBe("https://api.z.ai/api/paas/v4");
    const config = await getImageProviderConfigPublic(db(null));
    expect(config).toMatchObject({ configured: true, provider: "glm", source: "environment" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }), { status: 200 });
    }));
    expect((await glmImageProvider.getStatus({ apiKey: "zai-private-image-key-12345", model: "glm-image" })).ok).toBe(true);
    expect(calls).toEqual(["https://api.z.ai/api/paas/v4/images/generations"]);
  });

  it("does not claim image capability from an unrelated models endpoint", async () => {
    vi.stubEnv("GLM_BASE_URL", "https://api.z.ai/api/paas/v4");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid model", { status: 404 })));
    expect(await glmImageProvider.getStatus({ apiKey: "zai-private-image-key-12345", model: "not-an-image-model" }))
      .toMatchObject({ ok: false, code: "MODEL_INVALID" });
  });

  it("recognizes non-static language requests without marking normal websites non-static", () => {
    expect(requiresNonStaticRuntime("Build a Python FastAPI service")).toBe(true);
    expect(requiresNonStaticRuntime("Make a Rust CLI app")).toBe(true);
    expect(requiresNonStaticRuntime("Build a responsive JavaScript website")).toBe(false);
  });
});
