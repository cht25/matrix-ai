import "server-only";
import crypto from "node:crypto";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { canvasDocumentSchema, EMPTY_CANVAS, type CanvasRecord, type CanvasSummary } from "@/lib/canvas";

const COLLECTION = "canvas_documents";
const iso = (value: unknown) => (value as { toDate?: () => Date })?.toDate?.().toISOString() ?? "";
function record(id: string, data: Record<string, unknown>): CanvasRecord {
  return { id, title: String(data.title ?? "Untitled canvas"), project_id: typeof data.project_id === "string" ? data.project_id : null, revision: Number(data.revision ?? 1), document: canvasDocumentSchema.parse(data.document ?? EMPTY_CANVAS), updated_at: iso(data.updated_at) };
}
async function assertProject(d: Db, uid: string, projectId: string | null) {
  if (!projectId) return;
  const project = await d.collection("projects").doc(projectId).get();
  if (!project.exists || project.data()?.owner_id !== uid) throw new RpcError("PROJECT_NOT_FOUND", 404);
}
export async function createCanvas(d: Db, user: SessionUser, input: { title: string; project_id?: string | null; document?: unknown }) {
  const projectId = input.project_id || null;
  await assertProject(d, user.uid, projectId);
  const existing = await d.collection(COLLECTION).where("user_id", "==", user.uid).get();
  if (existing.docs.filter((doc) => !doc.data().deleted_at).length >= 100) throw new RpcError("CANVAS_LIMIT_REACHED", 409);
  const ref = d.collection(COLLECTION).doc();
  const document = canvasDocumentSchema.parse(input.document ?? EMPTY_CANVAS);
  const data = { user_id: user.uid, title: input.title.trim().slice(0, 120) || "Untitled canvas", project_id: projectId, document, revision: 1, version_count: 0, deleted_at: null, created_at: nowTs(), updated_at: nowTs() };
  await ref.set(data);
  return record(ref.id, data);
}
export async function listCanvases(d: Db, user: SessionUser): Promise<CanvasSummary[]> {
  const snap = await d.collection(COLLECTION).where("user_id", "==", user.uid).get();
  return snap.docs.filter((doc) => !doc.data().deleted_at).map((doc) => {
    const { id, title, project_id, revision, updated_at } = record(doc.id, doc.data());
    return { id, title, project_id, revision, updated_at };
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
export async function getCanvas(d: Db, user: SessionUser, id: string) {
  const snap = await d.collection(COLLECTION).doc(id).get();
  if (!snap.exists || snap.data()?.user_id !== user.uid || snap.data()?.deleted_at) throw new RpcError("NOT_FOUND", 404);
  return record(id, snap.data()!);
}
export async function saveCanvas(d: Db, user: SessionUser, input: { id: string; revision: number; title: string; project_id?: string | null; document: unknown }) {
  const document = canvasDocumentSchema.parse(input.document);
  const projectId = input.project_id || null;
  await assertProject(d, user.uid, projectId);
  const ref = d.collection(COLLECTION).doc(input.id);
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.user_id !== user.uid || snap.data()?.deleted_at) throw new RpcError("NOT_FOUND", 404);
    if (snap.data()?.revision !== input.revision) throw new RpcError("CANVAS_REVISION_CONFLICT", 409);
    tx.set(ref, { document, title: input.title.trim().slice(0, 120) || "Untitled canvas", project_id: projectId, revision: input.revision + 1, updated_at: nowTs() }, { merge: true });
  });
  return getCanvas(d, user, input.id);
}
export async function deleteCanvas(d: Db, user: SessionUser, id: string) {
  await getCanvas(d, user, id);
  await d.collection(COLLECTION).doc(id).set({ deleted_at: nowTs(), updated_at: nowTs() }, { merge: true });
  return true;
}
export async function saveCanvasVersion(d: Db, user: SessionUser, id: string) {
  const ref = d.collection(COLLECTION).doc(id);
  const versionId = crypto.randomUUID();
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.user_id !== user.uid || snap.data()?.deleted_at) throw new RpcError("NOT_FOUND", 404);
    const data = snap.data()!;
    const count = Number(data.version_count ?? 0);
    if (count >= 50) throw new RpcError("CANVAS_VERSION_LIMIT", 409);
    tx.set(ref.collection("versions").doc(versionId), { title: data.title, project_id: data.project_id ?? null, document: data.document, revision: data.revision, created_at: nowTs() });
    tx.set(ref, { version_count: count + 1 }, { merge: true });
  });
  return { id: versionId };
}
export async function listCanvasVersions(d: Db, user: SessionUser, id: string) {
  await getCanvas(d, user, id);
  const snap = await d.collection(COLLECTION).doc(id).collection("versions").get();
  return snap.docs.map((doc) => ({ id: doc.id, title: doc.data().title, revision: doc.data().revision, created_at: iso(doc.data().created_at) })).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
}
export async function restoreCanvasVersion(d: Db, user: SessionUser, id: string, versionId: string) {
  const ref = d.collection(COLLECTION).doc(id);
  await d.runTransaction(async (tx) => {
    const [snap, version] = await Promise.all([tx.get(ref), tx.get(ref.collection("versions").doc(versionId))]);
    if (!snap.exists || snap.data()?.user_id !== user.uid || snap.data()?.deleted_at || !version.exists) throw new RpcError("NOT_FOUND", 404);
    const data = version.data()!;
    tx.set(ref, { document: canvasDocumentSchema.parse(data.document), title: data.title, project_id: data.project_id ?? null, revision: Number(snap.data()?.revision ?? 0) + 1, updated_at: nowTs() }, { merge: true });
  });
  return getCanvas(d, user, id);
}
