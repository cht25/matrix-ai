import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/s/[slug]/[[...path]]/route";
import { loadPublishedFile } from "@/lib/server/deploy";

vi.mock("@/lib/firebase/admin", () => ({ adminDb: () => ({}) }));
vi.mock("@/lib/server/deploy", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/deploy")>();
  return { ...original, loadPublishedFile: vi.fn() };
});

const file = vi.mocked(loadPublishedFile);
const context = (slug: string, path: string[] = []) => ({ params: Promise.resolve({ slug, path }) });

describe("public hosting behind an internal upstream", () => {
  it("canonicalizes a direct public request without leaking the proxy's localhost origin", async () => {
    const res = await GET(new NextRequest("http://localhost:10000/s/index-html?ref=admin", {
      headers: { host: "localhost:10000", "x-forwarded-host": "matrix.thamjj13.top", "x-forwarded-proto": "https" },
    }), context("index-html"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/s/index-html/?ref=admin");
    expect(file).not.toHaveBeenCalled();
  });

  it("serves a public visitor and assets without a redirect or authentication", async () => {
    file.mockResolvedValueOnce({ path: "index.html", encoding: "utf8", content_type: "text/html", content: '<html><head></head><body><img src="pic.png"><script src="app.js"></script></body></html>' });
    const page = await GET(new NextRequest("http://localhost:10000/s/index-html/"), context("index-html"));
    expect(page.status).toBe(200);
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
    expect(await page.text()).toContain('<base href="/s/index-html/">');
    file.mockResolvedValueOnce({ path: "pic.png", encoding: "base64", content_type: "image/png", content: Buffer.from("image").toString("base64") });
    const image = await GET(new NextRequest("http://localhost:10000/s/index-html/pic.png"), context("index-html", ["pic.png"]));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(await image.text()).toBe("image");
  });

  it("serves a gated candidate release with no-store without disclosing it to visitors", async () => {
    file.mockResolvedValueOnce({ path: "index.html", encoding: "utf8", content_type: "text/html", content: "<html><body>New version</body></html>" });
    const req = new NextRequest("https://matrix.thamjj13.top/s/index-html/?__matrix_verify=v2", { headers: { "x-matrix-verification-token": "secret" } });
    const result = await GET(req, context("index-html"));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(file).toHaveBeenLastCalledWith(expect.anything(), "index-html", "index.html", { releaseId: "v2", token: "secret" });
    file.mockResolvedValueOnce(null);
    await GET(new NextRequest("https://matrix.thamjj13.top/s/index-html/?__matrix_verify=v2"), context("index-html"));
    expect(file).toHaveBeenLastCalledWith(expect.anything(), "index-html", "index.html", undefined);
  });
  it("resolves existing site files and nested SPA routes without creating or rewriting site records", async () => {
    const docs = [
      { data: () => ({ path: "index.html", content: "<html>SPA</html>", content_type: "text/html" }) },
      { data: () => ({ path: "assets/app.js", content: "console.log(1)", content_type: "text/javascript" }) },
      { data: () => ({ path: "about.html", content: "<html>About</html>", content_type: "text/html" }) },
    ];
    const get = vi.fn(async () => ({ docs, empty: false }));
    const site = { exists: true, data: () => ({ status: "live" }), ref: { collection: () => ({ get }) } };
    const db = { collection: () => ({ doc: () => ({ get: async () => site }) }) };
    const real = (await vi.importActual<typeof import("@/lib/server/deploy")>("@/lib/server/deploy")).loadPublishedFile;
    const store = db as unknown as Parameters<typeof real>[0];
    expect((await real(store, "index-html", "assets/app.js"))?.content).toBe("console.log(1)");
    expect((await real(store, "index-html", "about"))?.path).toBe("about.html");
    expect((await real(store, "index-html", "dashboard/settings"))?.path).toBe("index.html");
    expect(await real(store, "index-html", "assets/missing.js")).toBeNull();
  });
});
