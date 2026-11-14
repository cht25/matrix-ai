import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/firebase/admin";
import { createAIRoutesFromDb } from "@/lib/ai/config";
import { resolveMainModelConfig } from "@/lib/ai/runtime-config";
import { getManagedProviderRoutes, saveManagedProvider } from "@/lib/ai/managed-providers";
import { createUploadSignature } from "@/lib/server/cloudinary";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GLM primary main model, unverified managed providers, and Cloudinary signed paths", () => {
  it("defaults unsaved main model to GLM (never auto-promoting Gemini) and pairs with gpt-oss-120b for low-load tasks", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-test-primary-key-12345");
    vi.stubEnv("GLM_MODEL", "glm-4.7");
    vi.stubEnv("GEMINI_API_KEY", "AIzaSy-ignored-unless-explicit");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_fast_tier_key");
    vi.stubEnv("GROQ_CHAT_MODEL", "openai/gpt-oss-120b");

    const resolved = await resolveMainModelConfig(null);
    expect(resolved?.kind).toBe("glm");
    expect(resolved?.model).toBe("glm-4.7");
    expect(resolved?.low_task_model).toBe("openai/gpt-oss-120b");

    const highRoutes = await createAIRoutesFromDb(null, true, false, "high");
    expect(highRoutes[0].provider).toBe("GLM");
    expect(highRoutes[0].model).toBe("glm-5-turbo");

    const lowRoutes = await createAIRoutesFromDb(null, false, false, "low");
    expect(lowRoutes[0].provider).toBe("Groq");
    expect(lowRoutes[0].model).toBe("openai/gpt-oss-120b");
    expect(lowRoutes.every((r) => r.provider !== "GLM")).toBe(true);
    expect(lowRoutes.some((r) => r.provider === "Gemini")).toBe(false);
  });

  it("allows admin-saved managed providers with allow_unverified=true to chat even when /models returns 404", async () => {
    vi.stubEnv("PROVIDER_SECRET_KEY", "test-provider-secret-key-32bytes-min!!");

    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.endsWith("/models")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello from custom unverified gateway!" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    let storedDoc: Record<string, unknown> | null = null;
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: Boolean(storedDoc), data: () => storedDoc ?? {} }),
        }),
      }),
      runTransaction: async <T>(
        fn: (tx: { get: () => Promise<unknown>; set: (_r: unknown, data: Record<string, unknown>) => void }) => Promise<T>,
      ) =>
        fn({
          get: async () => ({ exists: Boolean(storedDoc), data: () => storedDoc ?? {} }),
          set: (_r, data) => {
            storedDoc = { ...(storedDoc ?? {}), ...data };
          },
        }),
    } as unknown as Db;

    await saveManagedProvider(db, "admin-1", {
      name: "Custom Gateway",
      kind: "openai-compatible",
      base_url: "https://gateway.example.com/v1",
      api_key: "sk-custom-gateway-key-999999",
      enabled: true,
      allow_unverified: true,
      models: [
        {
          id: "custom-model-v1",
          label: "Custom v1",
          enabled: true,
          use_for_chat: true,
          use_for_agent: false,
          use_for_vision: false,
        },
      ],
    });

    const targets = await getManagedProviderRoutes(db, "chat");
    expect(targets).toHaveLength(1);
    const reply = await targets[0].client.chat({
      model: targets[0].model,
      messages: [{ role: "user", content: "Ping" }],
    });
    expect(reply.content).toContain("Hello from custom unverified gateway!");
  });

  it("signs Cloudinary grants with folder-prefixed dot-free publicId across screenshots and mirror-frames", () => {
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "demo-cloud");
    vi.stubEnv("CLOUDINARY_API_KEY", "123456789");
    vi.stubEnv("CLOUDINARY_API_SECRET", "super-secret-cloudinary-key");

    const shot = createUploadSignature("userABC", "security-screenshots", "My Screenshot.2026.png")!;
    expect(shot).not.toBeNull();
    expect(shot.publicId.startsWith("security-screenshots/userABC/")).toBe(true);
    expect(shot.publicId.includes(".")).toBe(false);
    expect(shot.deliveryType).toBe("authenticated");

    const mirror = createUploadSignature("childXYZ", "mirror-frames", "frame.jpg")!;
    expect(mirror).not.toBeNull();
    expect(mirror.publicId.startsWith("mirror-frames/childXYZ/")).toBe(true);
    expect(mirror.deliveryType).toBe("authenticated");
  });
});
