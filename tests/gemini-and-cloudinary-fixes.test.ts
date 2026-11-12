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

describe("Gemini primary main model, unverified managed providers, and Cloudinary signed paths", () => {
  it("defaults unsaved main model to Gemini API (not OpenRouter) while remaining admin-editable", async () => {
    vi.stubEnv("GEMINI_API_KEY", "AIzaSy-test-gemini-key-12345");
    vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");

    const resolved = await resolveMainModelConfig(null);
    expect(resolved?.kind).toBe("gemini");
    expect(resolved?.model).toBe("gemini-2.5-flash");

    const routes = await createAIRoutesFromDb(null, false);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].provider).toBe("Gemini");
    expect(routes[0].model).toBe("gemini-2.5-flash");
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
