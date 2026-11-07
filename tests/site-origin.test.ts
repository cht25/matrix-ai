import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// siteOrigin() must NEVER return localhost in production, and must always use
// the canonical production domain when NEXT_PUBLIC_APP_URL is missing or
// points at a development URL.

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

async function loadSeo(appUrl?: string) {
  vi.resetModules();
  if (appUrl === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = appUrl;
  }
  return import("../src/lib/seo");
}

describe("siteOrigin() — single source of truth for public URLs", () => {
  it("returns the production domain when NEXT_PUBLIC_APP_URL is not set", async () => {
    const seo = await loadSeo(undefined);
    expect(seo.siteOrigin()).toBe("https://matrix.thamjj13.top");
  });

  it("returns the production domain when NEXT_PUBLIC_APP_URL is empty", async () => {
    const seo = await loadSeo("");
    expect(seo.siteOrigin()).toBe("https://matrix.thamjj13.top");
  });

  it("returns the production domain when NEXT_PUBLIC_APP_URL is localhost", async () => {
    const seo = await loadSeo("http://localhost:3000");
    expect(seo.siteOrigin()).toBe("https://matrix.thamjj13.top");
  });

  it("returns the production domain when NEXT_PUBLIC_APP_URL is 127.0.0.1", async () => {
    const seo = await loadSeo("http://127.0.0.1:3000");
    expect(seo.siteOrigin()).toBe("https://matrix.thamjj13.top");
  });

  it("returns the production domain when NEXT_PUBLIC_APP_URL is 0.0.0.0", async () => {
    const seo = await loadSeo("http://0.0.0.0:3000");
    expect(seo.siteOrigin()).toBe("https://matrix.thamjj13.top");
  });

  it("uses NEXT_PUBLIC_APP_URL when it is a valid production URL", async () => {
    const seo = await loadSeo("https://matrix.thamjj13.top");
    expect(seo.siteOrigin()).toBe("https://matrix.thamjj13.top");
  });

  it("uses a custom domain when set via NEXT_PUBLIC_APP_URL", async () => {
    const seo = await loadSeo("https://custom.example.com");
    expect(seo.siteOrigin()).toBe("https://custom.example.com");
  });

  it("normalizes a configured URL to its origin before appending public routes", async () => {
    const seo = await loadSeo("https://custom.example.com/some/path/");
    expect(seo.siteOrigin()).toBe("https://custom.example.com");
  });

  it("rejects credentials, query strings, fragments, and private targets", async () => {
    for (const value of [
      "https://user:pass@matrix.example",
      "https://matrix.example?next=/attacker",
      "https://matrix.example/#fragment",
      "https://192.168.1.3",
      "https://10.0.0.8",
      "https://[::1]",
      "https://metadata.google.internal",
    ]) {
      const seo = await loadSeo(value);
      expect(seo.siteOrigin(), value).toBe("https://matrix.thamjj13.top");
    }
  });

  it("requires HTTPS for configured production origins", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const seo = await loadSeo("http://matrix.example.com");
    expect(seo.siteOrigin()).toBe("https://matrix.thamjj13.top");
  });

  it("uses the canonical production origin rather than localhost as the unused legacy env.appUrl fallback", async () => {
    vi.resetModules();
    const { env } = await import("../src/lib/env");
    expect(env.appUrl).toBe("https://matrix.thamjj13.top");
  });

  it("PRODUCTION_ORIGIN is the canonical matrix subdomain", async () => {
    const seo = await loadSeo(undefined);
    expect(seo.PRODUCTION_ORIGIN).toBe("https://matrix.thamjj13.top");
  });

  it("never returns a localhost URL", async () => {
    const variants = [
      "http://localhost", "http://localhost:3000", "http://localhost:8080",
      "http://127.0.0.1", "http://127.0.0.1:3000",
      "http://0.0.0.0", "http://0.0.0.0:3000",
    ];
    for (const v of variants) {
      const seo = await loadSeo(v);
      expect(seo.siteOrigin()).not.toContain("localhost");
      expect(seo.siteOrigin()).not.toContain("127.0.0.1");
      expect(seo.siteOrigin()).not.toContain("0.0.0.0");
    }
  });
});
