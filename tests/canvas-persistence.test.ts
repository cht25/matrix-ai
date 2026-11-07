import { describe, expect, it } from "vitest";
import { EMPTY_CANVAS, canvasDocumentSchema, type CanvasDocument } from "@/lib/canvas";
import { createCanvas, getCanvas, saveCanvas, saveCanvasVersion, restoreCanvasVersion, listCanvasVersions } from "@/lib/server/canvas";
import type { Db } from "@/lib/firebase/admin";

const user = { uid: "canvas-owner", email: "owner@example.com", emailVerified: true };
function fixture() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({ id: path.split("/").at(-1)!, get: async () => ({ exists: docs.has(path), id: path.split("/").at(-1), data: () => docs.get(path), ref: ref(path) }), set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data); }, collection: (name: string) => collection(`${path}/${name}`) });
  const collection = (name: string) => ({ get: async () => ({ docs: [...docs.entries()].filter(([key]) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes("/")).map(([key, data]) => ({ id: key.split("/").at(-1)!, data: () => data })) }), doc: (id = `id-${docs.size}-${Math.random().toString(36).slice(2)}`) => ref(`${name}/${id}`), where: (field: string, _op: string, value: unknown) => ({ get: async () => ({ docs: [...docs.entries()].filter(([key, data]) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes("/") && data[field] === value).map(([key, data]) => ({ id: key.split("/").at(-1)!, data: () => data })) }) }) });
  let lock: Promise<unknown> = Promise.resolve();
  const db = { collection, runTransaction: (fn: (tx: unknown) => Promise<unknown>) => { const next = lock.then(() => fn({ get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, data: Record<string, unknown>, opts?: { merge?: boolean }) => r.set(data, opts) })); lock = next.catch(() => {}); return next; } } as unknown as Db;
  return { db, docs };
}
const node = { id: "note", type: "text" as const, x: 20, y: 30, width: 300, height: 180, content: "A persisted idea", color: "#3897ff" };
const document: CanvasDocument = { ...EMPTY_CANVAS, nodes: [node], edges: [] };

describe("visual canvas validation and persistence", () => {
  it("rejects dangling edges, duplicate IDs, script images and oversized coordinates", () => {
    expect(canvasDocumentSchema.parse(document).nodes[0].content).toBe("A persisted idea");
    expect(canvasDocumentSchema.safeParse({ ...document, edges: [{ id: "e", from: "note", to: "missing", label: "" }] }).success).toBe(false);
    expect(canvasDocumentSchema.safeParse({ ...document, nodes: [node, node] }).success).toBe(false);
    expect(canvasDocumentSchema.safeParse({ ...document, nodes: [{ ...node, type: "image", content: "javascript:alert(1)" }] }).success).toBe(false);
    expect(canvasDocumentSchema.safeParse({ ...document, nodes: [{ ...node, x: Infinity }] }).success).toBe(false);
  });
  it("persists edits, enforces ownership and detects stale-tab conflicts", async () => {
    const { db } = fixture();
    const created = await createCanvas(db, user, { title: "School plan", document });
    expect((await getCanvas(db, user, created.id)).document.nodes).toHaveLength(1);
    await expect(getCanvas(db, { ...user, uid: "attacker" }, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const input = { id: created.id, revision: 1, title: "School plan", document: { ...document, nodes: [{ ...node, content: "Updated" }] } };
    const results = await Promise.allSettled([saveCanvas(db, user, input), saveCanvas(db, user, input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({ reason: { code: "CANVAS_REVISION_CONFLICT" } });
    expect((await getCanvas(db, user, created.id)).revision).toBe(2);
  });
  it("creates and restores real snapshots and checks linked-project ownership", async () => {
    const { db, docs } = fixture();
    const created = await createCanvas(db, user, { title: "Canvas", document });
    await saveCanvasVersion(db, user, created.id);
    const version = (await listCanvasVersions(db, user, created.id))[0];
    await saveCanvas(db, user, { id: created.id, revision: 1, title: "Canvas", document: EMPTY_CANVAS });
    const restored = await restoreCanvasVersion(db, user, created.id, version.id);
    expect(restored.document.nodes[0].content).toBe("A persisted idea");
    expect(restored.revision).toBe(3);
    docs.set("projects/someone-else", { owner_id: "other" });
    await expect(createCanvas(db, user, { title: "Bad link", project_id: "someone-else" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});
