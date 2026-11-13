import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/firebase/admin";
import { loadPublishedFile } from "@/lib/server/deploy";
import { stagePublishedFiles } from "@/lib/deploy/firestore-provider";
import { verifyPublishedDeployment } from "@/lib/deploy/verify";

function firestoreFixture() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({
    id: path.split("/").at(-1)!,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path), ref: ref(path) }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data); },
    delete: async () => { docs.delete(path); },
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const collection = (path: string) => ({
    doc: (id: string) => ref(`${path}/${id}`),
    get: async () => { const items = [...docs].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")); return { empty: !items.length, docs: items.map(([key, data]) => ({ id: key.split("/").at(-1)!, data: () => data, ref: ref(key) })) }; },
    listDocuments: async () => [...docs.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")).map(ref),
  });
  return { docs, db: { collection } as unknown as Db };
}

const v1 = [{ path: "index.html", content: "<html><body><h1>Original portfolio</h1></body></html>", language: "html" }];
const v2 = [{ path: "index.html", content: '<html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Updated portfolio</h1></body></html>' , language: "html" }, { path: "styles.css", content: "body{color:blue}", language: "css" }];

describe("immutable publication of an existing site", () => {
  it("keeps legacy v1 public during v2 verification, then atomically switches the pointer", async () => {
    const { db, docs } = firestoreFixture();
    const site = db.collection("published_sites").doc("portfolio");
    await site.set({ owner_id: "owner", project_id: "p1", status: "live", deployment_id: "v1" });
    await site.collection("files").doc("legacy-file").set({ ...v1[0], content_type: "text/html" });
    const stage = await stagePublishedFiles(site, "v2", v2);
    await site.set({ verifying_release_id: "v2", verification_token: "secret" }, { merge: true });
    expect((await loadPublishedFile(db, "portfolio", "index.html"))?.content).toContain("Original");
    expect((await loadPublishedFile(db, "portfolio", "index.html", { releaseId: "v2", token: "wrong" }))?.content).toContain("Original");
    expect((await loadPublishedFile(db, "portfolio", "index.html", { releaseId: "v2", token: "secret" }))?.content).toContain("Updated");
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const request = new URL(String(url));
      if (!request.pathname.endsWith("/") && !request.pathname.endsWith(".css")) return new Response(null, { status: 308, headers: { Location: `${request.pathname}/${request.search}` } });
      const file = await loadPublishedFile(db, "portfolio", request.pathname.split("/portfolio/")[1] || "index.html", { releaseId: request.searchParams.get("__matrix_verify") || "", token: String((init?.headers as Record<string, string>)?.["x-matrix-verification-token"] || "") });
      return new Response(file?.content ?? "Not found", { status: file ? 200 : 404 });
    }) as typeof fetch;
    const verified = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "portfolio", files: v2, staging: { releaseId: "v2", token: "secret" }, fetchImpl });
    expect(verified).toMatchObject({ ok: true, error: null });
    expect(verified.checked).toHaveLength(3);
    await stage.commit();
    await site.set({ live_release_id: "v2", deployment_id: "v2", verifying_release_id: null, verification_token: null }, { merge: true });
    expect((await loadPublishedFile(db, "portfolio", "index.html"))?.content).toContain("Updated");
    expect(docs.get("published_sites/portfolio/files/legacy-file")?.content).toContain("Original");
    expect(docs.get("published_sites/portfolio")?.owner_id).toBe("owner");
  });
  it("restores a previous published version through a new release pointer", async () => {
    const { db } = firestoreFixture();
    const site = db.collection("published_sites").doc("portfolio");
    await site.set({ owner_id: "owner", project_id: "p1", status: "live" });
    await stagePublishedFiles(site, "v1", v1);
    await stagePublishedFiles(site, "v2", v2);
    await site.set({ live_release_id: "v2", deployment_id: "v2" }, { merge: true });
    expect((await loadPublishedFile(db, "portfolio", "index.html"))?.content).toContain("Updated");
    await stagePublishedFiles(site, "rollback-v3", v1);
    await site.set({ live_release_id: "rollback-v3", deployment_id: "rollback-v3" }, { merge: true });
    expect((await loadPublishedFile(db, "portfolio", "index.html"))?.content).toContain("Original");
    expect((await loadPublishedFile(db, "portfolio", "index.html", { releaseId: "v2", token: "guess" }))?.content).toContain("Original");
  });
  it("a partial Firestore write failure removes only candidate files", async () => {
    const { db, docs } = firestoreFixture();
    const site = db.collection("published_sites").doc("portfolio");
    await site.set({ owner_id: "owner", status: "live" });
    await site.collection("files").doc("legacy-file").set({ ...v1[0], content_type: "text/html" });
    const originalCollection = site.collection.bind(site);
    let writes = 0;
    const failingSite = { collection: (name: string) => {
      const col = originalCollection(name);
      if (name !== "releases") return col;
      return { doc: (releaseId: string) => ({ collection: (filesName: string) => {
        const files = col.doc(releaseId).collection(filesName);
        return { ...files, doc: (fileId: string) => {
          const file = files.doc(fileId);
          return { ...file, set: async (data: Record<string, unknown>) => {
            if (++writes === 2) throw new Error("Firestore write unavailable");
            await file.set(data);
          } };
        } };
      } }) };
    } } as unknown as typeof site;
    await expect(stagePublishedFiles(failingSite, "v2", v2)).rejects.toThrow("Firestore write unavailable");
    expect((await loadPublishedFile(db, "portfolio", "index.html"))?.content).toContain("Original");
    expect([...docs.keys()].filter((key) => key.startsWith("published_sites/portfolio/releases/v2/files/"))).toHaveLength(0);
  });
  it("failed v2 stage cleanup leaves v1 live, without duplicate published sites", async () => {
    const { db, docs } = firestoreFixture();
    const site = db.collection("published_sites").doc("portfolio");
    await site.set({ owner_id: "owner", status: "live" });
    await site.collection("files").doc("legacy-file").set({ ...v1[0], content_type: "text/html" });
    const stage = await stagePublishedFiles(site, "failed-v2", v2);
    await stage.restore();
    expect((await loadPublishedFile(db, "portfolio", "index.html"))?.content).toContain("Original");
    expect([...docs.keys()].filter((key) => key.startsWith("published_sites/portfolio/releases/failed-v2/files/"))).toHaveLength(0);
    expect([...docs.keys()].filter((key) => key === "published_sites/portfolio")).toHaveLength(1);
  });
});
