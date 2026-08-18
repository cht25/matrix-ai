import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// env.ts evaluates configuration at module scope, so each case re-imports the
// module with a different process.env.

const ORIGINAL = { ...process.env };

async function loadEnv(url?: string, key?: string) {
  vi.resetModules();
  if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  if (key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = key;
  return import("@/lib/env");
}

describe("Supabase client configuration detection", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = undefined as never;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = undefined as never;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  it("missing values are not configured", async () => {
    expect((await loadEnv(undefined, undefined)).isConfigured()).toBe(false);
    expect((await loadEnv("https://abc.supabase.co", undefined)).isConfigured()).toBe(false);
    expect((await loadEnv(undefined, "anon")).isConfigured()).toBe(false);
  });

  it("empty strings are not configured", async () => {
    expect((await loadEnv("", "")).isConfigured()).toBe(false);
  });

  it("malformed URLs are not configured", async () => {
    expect((await loadEnv("not-a-url", "anon")).isConfigured()).toBe(false);
    expect((await loadEnv("ftp://abc.supabase.co", "anon")).isConfigured()).toBe(false);
  });

  it(".env.example placeholders are not configured", async () => {
    expect((await loadEnv("https://YOUR-PROJECT.supabase.co", "your-anon-key")).isConfigured()).toBe(false);
    expect((await loadEnv("https://abc.supabase.co", "your-anon-key")).isConfigured()).toBe(false);
  });

  it("real values are configured", async () => {
    const mod = await loadEnv("https://bwjwktjclupjbuawjdeo.supabase.co", "eyJhbGciOi.def");
    expect(mod.isConfigured()).toBe(true);
    expect(mod.env.supabaseUrl).toBe("https://bwjwktjclupjbuawjdeo.supabase.co");
  });

  it("server secrets are exposed only via server env (never NEXT_PUBLIC_*)", async () => {
    const mod = await loadEnv("https://bwjwktjclupjbuawjdeo.supabase.co", "anon");
    expect(mod.env.serviceRoleKey).toBe("");
    expect(mod.env.groqApiKey).toBe("");
  });
});
