import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { verifyPublishedDeployment } from "@/lib/deploy/verify";
import { absoluteUrl } from "@/lib/deploy/format";
import { siteOrigin } from "@/lib/seo";

const files = [{ path: "index.html", content: '<html><head></head><body><h1>Real site</h1><link rel="stylesheet" href="styles.css"></body></html>', language: "html" }, { path: "styles.css", content: "body{color:green}", language: "css" }];

describe("deployment is proven over HTTP, not by a database row", () => {
  it("verifies the canonical entry URL and local assets", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => { calls.push(String(url)); return new Response(String(url).endsWith(".css") ? "body{}" : files[0].content, { status: 200 }); }) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "real-site", files, fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls[0]).toBe("https://matrix.thamjj13.top/s/real-site");
    expect(calls.some((url) => url.endsWith("/styles.css"))).toBe(true);
  });
  it("checks the actual admin-link entry redirect and then the slash URL and assets", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("/s/real-site")) {
        return new Response(null, { status: 308, headers: { Location: "/s/real-site/" } });
      }
      return new Response(String(url).endsWith(".css") ? "body{}" : files[0].content, { status: 200 });
    }) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "real-site", files, fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "https://matrix.thamjj13.top/s/real-site",
      "https://matrix.thamjj13.top/s/real-site/",
      "https://matrix.thamjj13.top/s/real-site/styles.css",
    ]);
  });
  it("accepts the correct document when hosting injects its site base", async () => {
    const served = files[0].content.replace("<head>", '<head><base href="/s/real-site/">');
    const fetchImpl = (async (url: string | URL) => new Response(String(url).endsWith(".css") ? "body{}" : served, { status: 200 })) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "real-site", files, fetchImpl });
    expect(result.ok).toBe(true);
  });
  it("rejects a cached previous version even when the response has an injected base tag", async () => {
    const stale = '<html><head><base href="/s/real-site/"></head><body><h1>Old site</h1></body></html>';
    const fetchImpl = (async () => new Response(stale, { status: 200 })) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "real-site", files, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("different content");
  });
  it("rejects upstream redirects instead of treating a localhost target as a live site", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 308, headers: { Location: "http://localhost:10000/s/real-site/" } });
    }) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "real-site", files, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the site path");
  });
  it("fails when the public URL or an asset is unavailable", async () => {
    const fetchImpl = (async (url: string | URL) => new Response(String(url).endsWith(".css") ? "missing" : files[0].content, { status: String(url).endsWith(".css") ? 404 : 200 })) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "x", files, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });
  it("never exposes localhost or private dev addresses as production links", () => {
    expect(absoluteUrl("http://localhost:3000/s/demo")).toBe("/s/demo");
    expect(absoluteUrl("http://127.0.0.1:3000/api/projects/p/preview")).toBe("");
    expect(absoluteUrl("http://192.168.1.5:3000/s/demo")).toBe("/s/demo");
    expect(absoluteUrl("https://matrix.thamjj13.top/s/demo")).toBe("https://matrix.thamjj13.top/s/demo");
    expect(siteOrigin()).not.toContain("localhost");
  });
  it("reports a timed-out public request without publishing", async () => {
    const fetchImpl = (async () => { throw new DOMException("This operation was aborted", "TimeoutError"); }) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "real-site", files, fetchImpl, timeoutMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
  });
  it("checks an isolated staged release and rejects a wrong redirect target", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      expect((init?.headers as Record<string, string>)["x-matrix-verification-token"]).toBe("private-token");
      return new Response(null, { status: 308, headers: { Location: "http://localhost:10000/s/real-site/" } });
    }) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "real-site", files, staging: { releaseId: "v2", token: "private-token" }, fetchImpl });
    expect(result.ok).toBe(false);
    expect(calls[0]).toContain("?__matrix_verify=v2");
    expect(result.error).toContain("outside the site path");
  });
  it("stages and verifies before activation, with restore on failure", () => {
    const provider = readFileSync("src/lib/deploy/firestore-provider.ts", "utf8");
    expect(provider).toContain("verifyPublishedDeployment");
    expect(provider).toContain("stage.restore()");
    expect(provider).toContain('verifying_release_id: deploymentRef.id');
    expect(provider).toContain('live_release_id: deploymentRef.id');
    expect(provider.indexOf("verifyPublishedDeployment")).toBeLessThan(provider.indexOf('push("activate", `Site live'));
    expect(provider).not.toContain("await Promise.all(oldFiles.map((file) => file.delete()));");
  });
});
