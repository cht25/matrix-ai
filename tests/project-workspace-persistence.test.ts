import { describe, expect, it } from "vitest";
import { applyProjectFiles, deleteProjectFile, ensureProject, getProject, listProjectVersions, renameProjectFile, restoreProjectVersion, saveProjectVersion, upsertProjectFile } from "@/lib/server/projects";
import type { Db } from "@/lib/firebase/admin";

const owner = { uid: "owner", email: "owner@example.com", emailVerified: true };
function fixture() {
  const docs = new Map<string, Record<string, unknown>>();
  docs.set("projects/p1", { owner_id: owner.uid, title: "Project", revision: 0, file_count: 0, created_at: new Date(), updated_at: new Date() });
  const matches = (name: string) => [...docs.entries()].filter(([key]) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes("/"));
  const ref = (path: string) => {
    const self = {
      id: path.split("/").at(-1)!, path,
      get: async () => ({ exists: docs.has(path), id: self.id, ref: self, data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data); },
      delete: async () => { docs.delete(path); },
      collection: (sub: string) => collection(`${path}/${sub}`),
    };
    return self;
  };
  const collection = (name: string) => ({
    doc: (id = `id-${docs.size}-${Math.random().toString(36).slice(2)}`) => ref(`${name}/${id}`),
    add: async (data: Record<string, unknown>) => { const id = `id-${docs.size}`; docs.set(`${name}/${id}`, data); return ref(`${name}/${id}`); },
    get: async () => { const rows = matches(name).map(([key, data]) => ({ id: key.split("/").at(-1)!, ref: ref(key), data: () => data })); return { docs: rows, size: rows.length, empty: !rows.length }; },
    where: (field: string, _op: string, value: unknown) => ({ limit: () => ({ get: async () => { const rows = matches(name).filter(([, data]) => data[field] === value).map(([key, data]) => ({ id: key.split("/").at(-1)!, ref: ref(key), data: () => data })); return { docs: rows, size: rows.length, empty: !rows.length }; } }), get: async () => { const rows = matches(name).filter(([, data]) => data[field] === value).map(([key, data]) => ({ id: key.split("/").at(-1)!, ref: ref(key), data: () => data })); return { docs: rows, size: rows.length, empty: !rows.length }; } }),
    listDocuments: async () => matches(name).map(([key]) => ref(key)),
  });
  let lock: Promise<unknown> = Promise.resolve();
  const db = { collection, runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
    const next = lock.then(async () => {
      const ops: Array<() => void> = [];
      const tx = { get: (target: { get: () => Promise<unknown> }) => target.get(),
        set: (target: ReturnType<typeof ref>, data: Record<string, unknown>, opts?: { merge?: boolean }) => { ops.push(() => { docs.set(target.path, opts?.merge ? { ...docs.get(target.path), ...data } : data); }); },
        delete: (target: ReturnType<typeof ref>) => { ops.push(() => { docs.delete(target.path); }); } };
      const result = await fn(tx); for (const op of ops) op(); return result;
    }); lock = next.catch(() => {}); return next;
  } } as unknown as Db;
  return { db, docs };
}

describe("transactional project workspace", () => {
  it("creates separate durable projects and reuses each conversation's project", async () => {
    const { db } = fixture();
    const a = await ensureProject(db, owner, { conversation_id: "chat-a", title: "Portfolio" });
    const b = await ensureProject(db, owner, { conversation_id: "chat-b", title: "Store" });
    expect(a.id).not.toBe(b.id);
    expect((await ensureProject(db, owner, { conversation_id: "chat-a", title: "Unrelated" })).id).toBe(a.id);
    await applyProjectFiles(db, owner, { project_id: a.id, files: [{ path: "index.html", content: "Portfolio", language: "html" }] });
    await applyProjectFiles(db, owner, { project_id: b.id, files: [{ path: "index.html", content: "Store", language: "html" }] });
    expect((await getProject(db, owner, a.id)).files[0].content).toBe("Portfolio");
    expect((await getProject(db, owner, b.id)).files[0].content).toBe("Store");
  });
  it("persists files across reload and never duplicates concurrent writes to one path", async () => {
    const { db, docs } = fixture();
    await Promise.all([upsertProjectFile(db, owner, { project_id: "p1", path: "index.html", content: "<h1>One</h1>" }), upsertProjectFile(db, owner, { project_id: "p1", path: "index.html", content: "<h1>Two</h1>" })]);
    const loaded = await getProject(db, owner, "p1");
    expect(loaded.files).toHaveLength(1);
    expect(loaded.project.revision).toBe(2);
    expect((await getProject(db, owner, "p1")).files[0].content).toBe(loaded.files[0].content);
  });
  it("rejects stale editors and foreign owners", async () => {
    const { db } = fixture();
    await upsertProjectFile(db, owner, { project_id: "p1", path: "a.js", content: "1" });
    await expect(upsertProjectFile(db, owner, { project_id: "p1", path: "a.js", content: "2", expected_revision: 0 })).rejects.toMatchObject({ code: "PROJECT_REVISION_CONFLICT" });
    await expect(upsertProjectFile(db, { ...owner, uid: "attacker" }, { project_id: "p1", path: "a.js", content: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("applies a multi-file change atomically and records a restore point", async () => {
    const { db } = fixture();
    await upsertProjectFile(db, owner, { project_id: "p1", path: "keep.txt", content: "keep" });
    await expect(applyProjectFiles(db, owner, { project_id: "p1", files: [{ path: "new.txt", content: "new", language: "text" }, { path: "../escape", content: "bad", language: "text" }] })).rejects.toBeTruthy();
    expect((await getProject(db, owner, "p1")).files.map((file) => file.path)).toEqual(["keep.txt"]);
    await applyProjectFiles(db, owner, { project_id: "p1", files: [{ path: "index.html", content: "<h1>Site</h1>", language: "html" }, { path: "styles.css", content: "body{}", language: "css" }] });
    const project = await getProject(db, owner, "p1");
    expect(project.files).toHaveLength(3);
    expect(project.project.file_manifest).toHaveLength(3);
    expect((await listProjectVersions(db, owner, "p1")).length).toBeGreaterThan(0);
  });
  it("persists the source manifest and dependency references without wiping unrelated files", async () => {
    const { db } = fixture();
    await applyProjectFiles(db, owner, { project_id: "p1", files: [
      { path: "index.html", content: "<h1>Portfolio</h1>", language: "html" },
      { path: "styles.css", content: "body { color: red }", language: "css" },
      { path: "package.json", content: '{"dependencies":{"lit":"^3.0.0"}}', language: "json" },
    ] });
    const before = await getProject(db, owner, "p1");
    expect(before.project).toMatchObject({ revision: 1, entry_point: "index.html", dependency_manifest: { lit: "^3.0.0" } });
    await applyProjectFiles(db, owner, { project_id: "p1", expected_revision: 1, files: [
      { path: "styles.css", content: "body { color: blue }", language: "css" },
    ] });
    const after = await getProject(db, owner, "p1");
    expect(after.project.revision).toBe(2);
    expect(after.files.map((f) => f.path)).toEqual(["index.html", "package.json", "styles.css"]);
    expect(after.files.find((f) => f.path === "index.html")?.content).toBe("<h1>Portfolio</h1>");
    expect(after.files.find((f) => f.path === "styles.css")?.content).toContain("blue");
    expect((await listProjectVersions(db, owner, "p1"))).toHaveLength(2);
  });
  it("renames/deletes and restores actual previous contents", async () => {
    const { db } = fixture();
    await upsertProjectFile(db, owner, { project_id: "p1", path: "old.txt", content: "original" });
    const version = await saveProjectVersion(db, owner, { project_id: "p1", source: "manual" });
    await renameProjectFile(db, owner, { project_id: "p1", from: "old.txt", to: "new.txt" });
    expect((await getProject(db, owner, "p1")).files.map((file) => file.path)).toEqual(["new.txt"]);
    await deleteProjectFile(db, owner, { project_id: "p1", path: "new.txt" });
    expect((await getProject(db, owner, "p1")).files).toHaveLength(0);
    await restoreProjectVersion(db, owner, { project_id: "p1", version_id: version.id });
    const restored = await getProject(db, owner, "p1");
    expect(restored.files[0]).toMatchObject({ path: "old.txt", content: "original" });
  });
});
