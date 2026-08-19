import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env.ts evaluates configuration at module scope, so each case re-imports the
// module with a different process.env.

const ORIGINAL = { ...process.env };

async function loadEnv(apiKey?: string, projectId?: string) {
  vi.resetModules();
  if (apiKey === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  else process.env.NEXT_PUBLIC_FIREBASE_API_KEY = apiKey;
  if (projectId === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  else process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = projectId;
  return import("../src/lib/env");
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = undefined as never;
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = undefined as never;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("Firebase configuration detection", () => {
  it("missing values are not configured", async () => {
    expect((await loadEnv(undefined, undefined)).isConfigured()).toBe(false);
    expect((await loadEnv("AIzaSyExample123", undefined)).isConfigured()).toBe(false);
    expect((await loadEnv(undefined, "my-project")).isConfigured()).toBe(false);
  });

  it("empty strings are not configured", async () => {
    expect((await loadEnv("", "")).isConfigured()).toBe(false);
  });

  it(".env.example placeholders are not configured", async () => {
    expect((await loadEnv("YOUR-API-KEY", "your-project-id")).isConfigured()).toBe(false);
    expect((await loadEnv("AIzaSyRealKey", "your-project-id")).isConfigured()).toBe(false);
    expect((await loadEnv("replace-with-api-key", "my-project")).isConfigured()).toBe(false);
  });

  it("real values are configured", async () => {
    const mod = await loadEnv("AIzaSyB1_93 chars-long-key", "matrix-ai-prod");
    expect(mod.isConfigured()).toBe(true);
    expect(mod.env.firebasePublic.projectId).toBe("matrix-ai-prod");
  });

  it("server secrets are never exposed via NEXT_PUBLIC_*", async () => {
    const mod = await loadEnv("AIzaSyB1_93 chars-long-key", "matrix-ai-prod");
    expect(mod.env.serviceEmail).toBe("");
    expect(mod.env.groqApiKey).toBe("");
    expect(mod.isServerConfigured()).toBe(false);
  });
});
