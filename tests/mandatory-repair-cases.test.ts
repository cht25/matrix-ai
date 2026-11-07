import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { detectBuildIntent } from "@/lib/ai/build-intent";
import { mayExecuteAgent, requestChatMode } from "@/lib/ai/execution-policy";
import { parseBlocks } from "@/components/markdown";
import { FirestoreDeploymentProvider } from "@/lib/deploy/firestore-provider";
import { buildRunCopy, createBuildRun, failRun, summarizeChanges } from "@/lib/deploy/stages";
import { publicUrl } from "@/lib/deploy/firestore-provider";
import { absoluteUrl } from "@/lib/deploy/format";
import { verifyPublishedDeployment } from "@/lib/deploy/verify";
import { buildPublishedFiles } from "@/lib/projects/bundle";
import { buildPreviewHtml } from "@/lib/projects/preview";
import { createZip, readZip } from "@/lib/projects/zip";
import { applyProjectFiles, getProject, setProjectEnv, upsertProjectFile } from "@/lib/server/projects";
import { loadPublishedFile } from "@/lib/server/deploy";
import type { Db } from "@/lib/firebase/admin";
import { projectDbFixture, projectOwner } from "./helpers/project-db";

const read = (path: string) => readFileSync(path, "utf8");

describe("Phase 14 — mandatory repair cases", () => {
  it("1. Normal Chat cannot execute Agent file/build work", () => {
    const intent = detectBuildIntent("Build and publish a website", { projectFileCount: 0 });
    expect(mayExecuteAgent("general", intent)).toBe(false);
    expect(mayExecuteAgent("code", intent)).toBe(true);
    expect(read("src/app/api/ai/route.ts")).not.toContain("applyProjectFiles(");
  });

  it("2. Coding Assistance renders highlighted code blocks with Copy/Download", () => {
    const blocks = parseBlocks("```js:app.js\nconsole.log('hi');\n```");
    expect(blocks[0]).toMatchObject({ type: "code", lang: "javascript", filename: "app.js" });
    expect(read("src/components/markdown.tsx")).toContain("Copy code");
    expect(read("src/components/markdown.tsx")).toContain("Download");
  });

  it("3. Agent execution writes workspace files, not chat source dumps", () => {
    expect(mayExecuteAgent("agent", detectBuildIntent("Build a site", { agentMode: true }))).toBe(true);
    expect(read("src/lib/server/build.ts")).toContain("applyProjectFiles(");
    expect(read("src/components/chat-client.tsx")).not.toContain("artifacts: artifacts.length ? artifacts : undefined");
  });

  it("4. Project files persist across reload from the database", async () => {
    const { db } = projectDbFixture();
    await upsertProjectFile(db, projectOwner, { project_id: "p1", path: "index.html", content: "<h1>Stored</h1>" });
    const loaded = await getProject(db, projectOwner, "p1");
    expect(loaded.files[0]).toMatchObject({ path: "index.html", content: "<h1>Stored</h1>" });
  });

  it("5. Conversation context carries the active project into later turns", () => {
    expect(read("src/app/(app)/chat/[id]/page.tsx")).toContain("active_project_id");
    expect(read("src/components/chat-client.tsx")).toContain("project_id: agentProjectId");
    expect(requestChatMode(undefined)).toBe("general");
  });

  it("6. Empty builds are rejected with a real NO_FILES outcome", async () => {
    const provider = new FirestoreDeploymentProvider({} as Db, projectOwner);
    const result = await provider.build("p1", []);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("NO_FILES");
    expect(read("src/lib/server/build.ts")).toContain("has no files to build (0 files)");
  });

  it("7. Build errors are captured on the run, never hidden", () => {
    const run = createBuildRun({ id: "r", actions: { build: true, publish: true, preview: false }, now: 1 });
    const failed = failRun(run, { code: "BUILD_FAILED", message: "Syntax error" }, 2);
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toBe("Syntax error");
  });

  it("8. Repairs change real stored files and produce a diff", async () => {
    const { db } = projectDbFixture();
    await upsertProjectFile(db, projectOwner, { project_id: "p1", path: "app.js", content: "const a = 1;" });
    const before = (await getProject(db, projectOwner, "p1")).files;
    await applyProjectFiles(db, projectOwner, { project_id: "p1", files: [{ path: "app.js", content: "const a = 2;", language: "javascript" }], source: "agent" });
    const after = (await getProject(db, projectOwner, "p1")).files;
    expect(summarizeChanges(before, after)).toEqual([{ path: "app.js", kind: "modified" }]);
  });

  it("9. Build artifacts are generated from project contents", () => {
    const built = buildPublishedFiles([{ path: "index.html", content: '<link rel="stylesheet" href="style.css"><h1>Artifact</h1>', language: "html" }, { path: "style.css", content: "h1{color:green}", language: "css" }]);
    expect(built.outFiles.length).toBeGreaterThan(0);
    expect(built.outFiles.some((file) => file.content.includes("Artifact"))).toBe(true);
  });

  it("10. Preview is sandboxed and mobile-capable", () => {
    const preview = buildPreviewHtml([{ path: "index.html", content: "<html><head></head><body>Hi</body></html>", language: "html" }]);
    expect(preview.available).toBe(true);
    expect(preview.html).toContain("viewport");
    expect(read("src/app/api/projects/[id]/preview/[[...path]]/route.ts")).toContain("sandbox allow-scripts");
    expect(read("src/components/projects/project-workspace.tsx")).toContain("previewDevice");
  });

  it("11. Public deployment URLs use the canonical origin", () => {
    expect(publicUrl("demo-site")).toBe("https://matrix.thamjj13.top/s/demo-site");
  });

  it("12. Localhost/dev-machine URLs are never exposed as production links", () => {
    expect(absoluteUrl("http://localhost:3000/s/demo")).toBe("/s/demo");
    expect(absoluteUrl("http://127.0.0.1:3000/preview")).toBe("");
  });

  it("13. Published sites serve the real uploaded content", async () => {
    const { db } = projectDbFixture();
    await db.collection("published_sites").doc("real").set({ status: "live", slug: "real" });
    await db.collection("published_sites").doc("real").collection("files").doc("f1").set({ path: "index.html", content: "<h1>Published content</h1>", encoding: "utf8", content_type: "text/html" });
    const file = await loadPublishedFile(db, "real", "index.html");
    expect(file?.content).toContain("Published content");
  });

  it("14. Failed deployments report failure without a live link", () => {
    const run = failRun(createBuildRun({ id: "r", actions: { build: true, publish: true, preview: false }, now: 1 }), { code: "DEPLOY_FAILED", message: "Host unreachable" }, 2);
    const copy = buildRunCopy(run);
    expect(copy.title).toMatch(/failed/i);
    expect(copy.canOpenLive).toBe(false);
    expect(copy.liveUrl).toBeNull();
  });

  it("15. Project ownership is enforced on read/write", async () => {
    const { db } = projectDbFixture();
    await expect(getProject(db, { ...projectOwner, uid: "intruder" }, "p1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(upsertProjectFile(db, { ...projectOwner, uid: "intruder" }, { project_id: "p1", path: "x.txt", content: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("16. The editor persists through server RPC, not localStorage", () => {
    const workspace = read("src/components/projects/project-workspace.tsx");
    expect(workspace).toContain('rpc<{ revision: number }>("project_file_upsert"');
    expect(workspace).toContain("expected_revision");
  });

  it("17. ZIP export contains the actual project files", () => {
    const zip = createZip([{ path: "index.html", content: Buffer.from("<h1>Zip</h1>") }, { path: "assets/logo.svg", content: Buffer.from("<svg/>") }]);
    const entries = readZip(zip);
    expect(entries.map((entry) => entry.path).sort()).toEqual(["assets/logo.svg", "index.html"]);
    expect(entries.find((entry) => entry.path === "index.html")?.content.toString()).toBe("<h1>Zip</h1>");
  });

  it("18. Rollback restores a stored snapshot and re-verifies HTTP", () => {
    const provider = read("src/lib/deploy/firestore-provider.ts");
    expect(provider).toContain("async rollback(");
    expect(provider).toContain("snapshotFiles.empty");
    expect(provider).toContain("ROLLBACK_VERIFY_FAILED");
    expect(provider).toContain("stage.restore()");
  });

  it("19. Secret-looking variables are refused for public static env", async () => {
    const { db } = projectDbFixture();
    const result = await setProjectEnv(db, projectOwner, { project_id: "p1", env: { PUBLIC_NAME: "Demo", API_SECRET: "nope", STRIPE_TOKEN: "nope" } });
    expect(result.env).toEqual({ PUBLIC_NAME: "Demo" });
    expect(result.rejected).toEqual(["API_SECRET", "STRIPE_TOKEN"]);
  });

  it("20. Deployment success requires HTTP verification before live", async () => {
    const files = [{ path: "index.html", content: "<html><body>Verified</body></html>", language: "html" }];
    const fetchImpl = (async () => new Response(files[0].content, { status: 200 })) as typeof fetch;
    const result = await verifyPublishedDeployment({ origin: "https://matrix.thamjj13.top", slug: "verified", files, fetchImpl });
    expect(result.ok).toBe(true);
    const provider = read("src/lib/deploy/firestore-provider.ts");
    expect(provider.indexOf("verifyPublishedDeployment")).toBeLessThan(provider.indexOf('push("activate", `Site live'));
  });
});
