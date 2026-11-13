import { describe, expect, it } from "vitest";
import { FirestoreDeploymentProvider, readStoredUrls } from "@/lib/deploy/firestore-provider";

const origin = "https://matrix.thamjj13.top";

describe("existing published sites retain their identity but not an old localhost origin", () => {
  it("resolves generated URL entries without mutating IDs, ownership or stored data", () => {
    const stored = { live_slug: "index-html", urls: [
      { id: "slug-index-html", kind: "generated", slug: "index-html", url: "http://localhost:10000/s/index-html", primary: true, status: "active" },
      { id: "preview", kind: "preview", url: "/api/projects/p/preview" },
    ] };
    const urls = readStoredUrls(stored, "p");
    expect(urls[0]).toMatchObject({ id: "slug-index-html", slug: "index-html", primary: true, url: `${origin}/s/index-html` });
    expect(urls[1].url).toBe("/api/projects/p/preview");
    expect(stored.urls[0].url).toBe("http://localhost:10000/s/index-html");
    expect(urls).toHaveLength(2);
  });
  it("recovers a legacy generated slug from its path, never its localhost origin", () => {
    const urls = readStoredUrls({ urls: [
      { id: "legacy", kind: "generated", url: "http://localhost:10000/s/older-site", primary: true },
      { id: "invalid", kind: "generated", url: "http://localhost:10000/other" },
    ] }, "p");
    expect(urls.find((entry) => entry.id === "legacy")).toMatchObject({ slug: "older-site", url: `${origin}/s/older-site` });
    expect(urls.find((entry) => entry.id === "invalid")).toBeUndefined();
  });
  it("ignores legacy deployment public_url for live records", () => {
    const provider = new FirestoreDeploymentProvider({} as never, { uid: "owner" } as never);
    const record = (provider as unknown as { toRecord: (id: string, data: Record<string, unknown>) => { id: string; url: string | null } }).toRecord("dep-1", {
      status: "live", slug: "another-site", project_id: "p", owner_id: "owner", public_url: "http://127.0.0.1:10000/s/another-site",
    });
    expect(record).toMatchObject({ id: "dep-1", url: `${origin}/s/another-site` });
  });
});
