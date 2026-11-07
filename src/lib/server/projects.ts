import "server-only";
import crypto from "node:crypto";
import type { Transaction } from "firebase-admin/firestore";
import { Db, nowTs } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { descDoc } from "@/lib/server/sort";
import {
  PROJECT_LIMITS,
  assertSafeProjectPath,
  isImagePath,
  isTextPath,
  slugify,
  withLanguage,
  type ProjectFile,
} from "@/lib/projects/paths";

const iso = (v: unknown): string => {
  const ts = v as { toDate?: () => Date } | null | undefined;
  if (ts?.toDate) return ts.toDate().toISOString();
  return typeof v === "string" ? v : "";
};

export type ProjectSummary = {
  id: string;
  title: string;
  description: string;
  stack: string;
  conversation_id: string | null;
  file_count: number;
  revision: number;
  updated_at: string;
  created_at: string;
  live_slug: string | null;
  live_url: string | null;
};

async function ownedProject(d: Db, user: SessionUser, projectId: string) {
  const ref = d.collection("projects").doc(projectId);
  const doc = await ref.get();
  if (!doc.exists || doc.data()!.owner_id !== user.uid || doc.data()!.archived_at) {
    throw new RpcError("NOT_FOUND", 404);
  }
  return { ref, data: doc.data()! };
}

export async function listProjects(d: Db, user: SessionUser): Promise<ProjectSummary[]> {
  const snap = await d.collection("projects").where("owner_id", "==", user.uid).get();
  return snap.docs
    .filter((doc) => !doc.data().archived_at)
    .sort(descDoc("updated_at"))
    .slice(0, 40)
    .map((doc) => ({
      id: doc.id,
      title: doc.data().title ?? "Untitled project",
      description: doc.data().description ?? "",
      stack: doc.data().stack ?? "static-web",
      conversation_id: doc.data().conversation_id ?? null,
      file_count: doc.data().file_count ?? 0,
      revision: Number(doc.data().revision ?? 0),
      updated_at: iso(doc.data().updated_at),
      created_at: iso(doc.data().created_at),
      live_slug: doc.data().live_slug ?? null,
      live_url: doc.data().live_url ?? null,
    }));
}

export async function ensureProject(
  d: Db,
  user: SessionUser,
  p: { conversation_id?: string | null; title?: string },
) {
  if (p.conversation_id) {
    const existing = await d.collection("projects").where("conversation_id", "==", p.conversation_id).limit(5).get();
    const mine = existing.docs.find((doc) => doc.data().owner_id === user.uid && !doc.data().archived_at);
    if (mine) return { id: mine.id, title: mine.data().title ?? "Untitled project", file_count: mine.data().file_count ?? 0 };
  }
  const current = await d.collection("projects").where("owner_id", "==", user.uid).get();
  const active = current.docs.filter((doc) => !doc.data().archived_at).length;
  if (active >= PROJECT_LIMITS.maxProjectsPerUser) throw new RpcError("PROJECT_LIMIT", 400);
  const title = (p.title?.trim() || "Untitled project").slice(0, 80);
  const created = await d.collection("projects").add({
    owner_id: user.uid,
    title,
    description: "",
    stack: "static-web",
    conversation_id: p.conversation_id ?? null,
    file_count: 0,
    revision: 0,
    framework: "html",
    runtime: "static",
    live_slug: null,
    live_url: null,
    env_public: {},
    custom_domain: "",
    custom_domain_status: "",
    custom_domain_token: "",
    archived_at: null,
    created_at: nowTs(),
    updated_at: nowTs(),
  });
  return { id: created.id, title, file_count: 0 };
}

export async function getProject(d: Db, user: SessionUser, projectId: string) {
  const { data } = await ownedProject(d, user, projectId);
  const files = await d.collection("projects").doc(projectId).collection("files").get();
  return {
    project: {
      id: projectId,
      title: data.title ?? "Untitled project",
      description: data.description ?? "",
      stack: data.stack ?? "static-web",
      framework: data.framework ?? (data.stack === "static-web" ? "html" : String(data.stack)),
      runtime: data.runtime ?? "static",
      revision: Number(data.revision ?? 0),
      file_manifest: Array.isArray(data.file_manifest) ? data.file_manifest : [],
      conversation_id: data.conversation_id ?? null,
      live_slug: data.live_slug ?? null,
      live_url: data.live_url ?? null,
      env_public: (data.env_public ?? {}) as Record<string, string>,
      custom_domain: data.custom_domain ?? "",
      custom_domain_status: data.custom_domain_status ?? "",
      updated_at: iso(data.updated_at),
    },
    files: files.docs
      .map((doc) =>
        withLanguage({
          path: doc.data().path,
          content: doc.data().content ?? "",
          encoding: doc.data().encoding === "base64" ? "base64" : "utf8",
        }),
      )
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function updateProject(d: Db, user: SessionUser, p: { id: string; title?: string; description?: string; archive?: boolean }) {
  const { ref } = await ownedProject(d, user, p.id);
  const patch: Record<string, unknown> = { updated_at: nowTs() };
  if (typeof p.title === "string") patch.title = p.title.trim().slice(0, 80) || "Untitled project";
  if (typeof p.description === "string") patch.description = p.description.trim().slice(0, 400);
  if (p.archive) patch.archived_at = nowTs();
  await ref.set(patch, { merge: true });
  return true;
}

export function projectFileId(path: string): string {
  return `f_${crypto.createHash("sha256").update(assertSafeProjectPath(path)).digest("hex").slice(0, 40)}`;
}

type StoredFile = { path: string; content: string; encoding: "utf8" | "base64"; language?: string; created_at?: unknown; updated_at?: unknown; updated_by?: string };
function fileBytes(file: { content: string; encoding?: string }): number {
  return file.encoding === "base64" ? Math.floor(file.content.length * 0.75) : Buffer.byteLength(file.content, "utf8");
}
function validateFile(path: string, content: string, encoding: "utf8" | "base64") {
  if (encoding === "utf8" && Buffer.byteLength(content, "utf8") > PROJECT_LIMITS.maxTextBytes) throw new RpcError("FILE_TOO_LARGE", 400);
  if (encoding === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) throw new RpcError("FILE_ENCODING_INVALID", 400);
    if (fileBytes({ content, encoding }) > PROJECT_LIMITS.maxImageBytes) throw new RpcError("FILE_TOO_LARGE", 400);
  }
  void path;
}
function manifestFor(files: StoredFile[]) {
  return files.sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ path: file.path, bytes: fileBytes(file), encoding: file.encoding, sha256: crypto.createHash("sha256").update(file.content).digest("hex") }));
}
async function readOwnedInTransaction(tx: Transaction, d: Db, user: SessionUser, projectId: string) {
  const ref = d.collection("projects").doc(projectId);
  const snap = await tx.get(ref);
  if (!snap.exists || snap.data()?.owner_id !== user.uid || snap.data()?.archived_at) throw new RpcError("NOT_FOUND", 404);
  return { ref, data: snap.data()!, revision: Number(snap.data()?.revision ?? 0) };
}
function assertRevision(current: number, expected?: number) {
  if (expected !== undefined && expected !== current) throw new RpcError("PROJECT_REVISION_CONFLICT", 409);
}

/** One transactional write boundary for editor and Agent file operations. */
async function mutateFiles(
  d: Db, user: SessionUser, projectId: string,
  change: (current: Map<string, StoredFile & { id: string }>) => { files: Map<string, StoredFile & { id: string }>; deleted?: string[] },
  opts: { expectedRevision?: number; source?: string; snapshot?: { source: string; summary: string } } = {},
) {
  return d.runTransaction(async (tx) => {
    const { ref, revision } = await readOwnedInTransaction(tx, d, user, projectId);
    assertRevision(revision, opts.expectedRevision);
    const filesRef = ref.collection("files");
    const snap = await tx.get(filesRef);
    const current = new Map<string, StoredFile & { id: string }>();
    for (const doc of snap.docs) { const data = doc.data() as StoredFile; if (data.path) current.set(data.path, { ...data, id: doc.id }); }
    const before = new Map(current);
    const result = change(current);
    const files = [...result.files.values()];
    if (files.length > PROJECT_LIMITS.maxFilesPerProject) throw new RpcError("TOO_MANY_FILES", 400);
    const imageBytes = files.filter((file) => file.encoding === "base64" || isImagePath(file.path)).reduce((sum, file) => sum + fileBytes(file), 0);
    if (imageBytes > PROJECT_LIMITS.maxImageBytesPerProject) throw new RpcError("IMAGE_BUDGET", 400);
    const stamp = nowTs();
    for (const [path, old] of before) { if (!result.files.has(path)) tx.delete(filesRef.doc(old.id)); }
    for (const file of files) {
      validateFile(file.path, file.content, file.encoding);
      const old = before.get(file.path);
      if (old && old.content === file.content && old.encoding === file.encoding && old.path === file.path) continue;
      const id = old?.id ?? projectFileId(file.path);
      tx.set(filesRef.doc(id), { path: file.path, content: file.content, encoding: file.encoding, language: withLanguage({ path: file.path, content: file.content, encoding: file.encoding }).language, updated_by: opts.source === "agent" ? "agent" : "user", created_at: old?.created_at ?? stamp, updated_at: stamp }, { merge: true });
    }
    const nextRevision = revision + 1;
    tx.set(ref, { file_count: files.length, file_manifest: manifestFor(files.map((file) => ({ ...file }))), revision: nextRevision, updated_at: stamp }, { merge: true });
    if (opts.snapshot) {
      const version = ref.collection("versions").doc();
      tx.set(version, { source: opts.snapshot.source, summary: opts.snapshot.summary.slice(0, 200), file_count: files.length, revision: nextRevision, created_at: stamp });
      for (const file of files) tx.set(version.collection("files").doc(projectFileId(file.path)), { path: file.path, content: file.content, encoding: file.encoding });
    }
    return { revision: nextRevision, file_count: files.length };
  });
}

export async function upsertProjectFile(
  d: Db, user: SessionUser,
  p: { project_id: string; path: string; content: string; encoding?: "utf8" | "base64"; source?: string; expected_revision?: number },
) {
  const path = assertSafeProjectPath(p.path); const encoding = p.encoding === "base64" ? "base64" : "utf8";
  validateFile(path, p.content, encoding);
  const result = await mutateFiles(d, user, p.project_id, (current) => { current.set(path, { path, content: p.content, encoding, id: current.get(path)?.id ?? projectFileId(path) }); return { files: current }; }, { expectedRevision: p.expected_revision, source: p.source });
  return { path, ...result };
}

export async function deleteProjectFile(d: Db, user: SessionUser, p: { project_id: string; path: string; expected_revision?: number }) {
  const path = assertSafeProjectPath(p.path);
  await mutateFiles(d, user, p.project_id, (current) => { if (!current.delete(path)) throw new RpcError("NOT_FOUND", 404); return { files: current, deleted: [path] }; }, { expectedRevision: p.expected_revision });
  return true;
}

export async function renameProjectFile(d: Db, user: SessionUser, p: { project_id: string; from: string; to: string; expected_revision?: number }) {
  const from = assertSafeProjectPath(p.from); const to = assertSafeProjectPath(p.to);
  await mutateFiles(d, user, p.project_id, (current) => {
    const file = current.get(from); if (!file) throw new RpcError("NOT_FOUND", 404);
    if (current.has(to)) throw new RpcError("PATH_EXISTS", 400);
    current.delete(from); current.set(to, { ...file, path: to, id: projectFileId(to) });
    return { files: current, deleted: [from] };
  }, { expectedRevision: p.expected_revision });
  return true;
}

export async function applyProjectFiles(
  d: Db, user: SessionUser,
  p: { project_id: string; files: ProjectFile[]; source?: string; title?: string; expected_revision?: number },
) {
  if (!p.files.length) throw new RpcError("NO_FILES", 400);
  if (p.files.length > PROJECT_LIMITS.maxFilesPerProject) throw new RpcError("TOO_MANY_FILES", 400);
  const paths = new Set<string>();
  for (const file of p.files) { const path = assertSafeProjectPath(file.path); if (paths.has(path)) throw new RpcError("DUPLICATE_PATH", 400); paths.add(path); validateFile(path, file.content, file.encoding === "base64" ? "base64" : "utf8"); }
  const result = await mutateFiles(d, user, p.project_id, (current) => {
    for (const file of p.files) { const path = assertSafeProjectPath(file.path); const encoding = file.encoding === "base64" ? "base64" : "utf8"; current.set(path, { path, content: file.content, encoding, id: current.get(path)?.id ?? projectFileId(path) }); }
    return { files: current };
  }, { expectedRevision: p.expected_revision, source: p.source ?? "agent", snapshot: { source: p.source === "import" ? "import" : p.source === "user" ? "user" : "agent", summary: `Applied ${p.files.length} file${p.files.length === 1 ? "" : "s"}` } });
  if (p.title) await updateProject(d, user, { id: p.project_id, title: p.title });
  return { count: p.files.length, ...result };
}

export async function saveProjectVersion(
  d: Db, user: SessionUser,
  p: { project_id: string; source: string; summary?: string },
) {
  const id = await d.runTransaction(async (tx) => {
    const { ref } = await readOwnedInTransaction(tx, d, user, p.project_id);
    const files = await tx.get(ref.collection("files"));
    const version = ref.collection("versions").doc();
    tx.set(version, { source: p.source, summary: (p.summary ?? "").slice(0, 200), file_count: files.size, created_at: nowTs() });
    for (const doc of files.docs) tx.set(version.collection("files").doc(projectFileId(String(doc.data().path))), { path: doc.data().path, content: doc.data().content ?? "", encoding: doc.data().encoding ?? "utf8" });
    return version.id;
  });
  // Retention is maintenance, not part of the user's atomic save.
  const versions = await d.collection("projects").doc(p.project_id).collection("versions").get();
  const ordered = versions.docs.sort(descDoc("created_at"));
  for (const old of ordered.slice(PROJECT_LIMITS.maxVersions)) {
    const kids = await old.ref.collection("files").listDocuments();
    await Promise.all(kids.map((kid) => kid.delete()));
    await old.ref.delete();
  }
  return { id };
}

export async function listProjectVersions(d: Db, user: SessionUser, projectId: string) {
  await ownedProject(d, user, projectId);
  const snap = await d.collection("projects").doc(projectId).collection("versions").get();
  return snap.docs.sort(descDoc("created_at")).slice(0, 25).map((doc) => ({
    id: doc.id,
    source: doc.data().source ?? "autosave",
    summary: doc.data().summary ?? "",
    file_count: doc.data().file_count ?? 0,
    created_at: iso(doc.data().created_at),
  }));
}

export async function restoreProjectVersion(d: Db, user: SessionUser, p: { project_id: string; version_id: string; expected_revision?: number }) {
  return d.runTransaction(async (tx) => {
    const { ref, revision } = await readOwnedInTransaction(tx, d, user, p.project_id);
    assertRevision(revision, p.expected_revision);
    const version = ref.collection("versions").doc(p.version_id);
    const versionSnap = await tx.get(version);
    if (!versionSnap.exists) throw new RpcError("NOT_FOUND", 404);
    const snapshot = await tx.get(version.collection("files"));
    const current = await tx.get(ref.collection("files"));
    const stamp = nowTs();
    const backup = ref.collection("versions").doc();
    tx.set(backup, { source: "restore", summary: "Snapshot before restore", file_count: current.size, created_at: stamp });
    for (const doc of current.docs) {
      tx.set(backup.collection("files").doc(projectFileId(String(doc.data().path))), { path: doc.data().path, content: doc.data().content ?? "", encoding: doc.data().encoding ?? "utf8" });
      tx.delete(doc.ref);
    }
    const restored: StoredFile[] = [];
    for (const doc of snapshot.docs) {
      const file = { path: String(doc.data().path), content: String(doc.data().content ?? ""), encoding: doc.data().encoding === "base64" ? "base64" as const : "utf8" as const };
      validateFile(file.path, file.content, file.encoding); restored.push(file);
      tx.set(ref.collection("files").doc(projectFileId(file.path)), { ...file, language: withLanguage(file).language, updated_by: "user", created_at: stamp, updated_at: stamp });
    }
    if (restored.length > PROJECT_LIMITS.maxFilesPerProject) throw new RpcError("TOO_MANY_FILES", 400);
    tx.set(ref, { file_count: restored.length, file_manifest: manifestFor(restored), revision: revision + 1, updated_at: stamp }, { merge: true });
    return { revision: revision + 1, file_count: restored.length };
  });
}

/**
 * Public runtime variables (§35).
 *
 * MATRIX hosting serves static documents — a deployed project has no server
 * process that could hold a secret. Anything stored here is injected into the
 * published page as `window.MATRIX_ENV`, so it is PUBLIC by construction and
 * keys that look like secrets are refused outright rather than quietly stored.
 * Provider credentials and deployment tokens never pass through this path.
 */
export function looksLikeSecretKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  if (/(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|APIKEY|API_KEY|ACCESS_KEY|SECRET_KEY|SIGNING|SESSION|OTP|REFRESH)/.test(normalized)) return true;
  return /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD)($|_)/.test(normalized);
}

export async function setProjectEnv(
  d: Db,
  user: SessionUser,
  p: { project_id: string; env: Record<string, string> },
): Promise<{ env: Record<string, string>; rejected: string[] }> {
  const { ref } = await ownedProject(d, user, p.project_id);
  const clean: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(p.env).slice(0, 30)) {
    const k = key.trim().slice(0, 40);
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
    if (looksLikeSecretKey(k)) {
      rejected.push(k);
      continue;
    }
    clean[k] = String(value).slice(0, 500);
  }
  await ref.set({ env_public: clean, updated_at: nowTs() }, { merge: true });
  return { env: clean, rejected };
}

/** A directory is materialised the way git does it: a `.gitkeep` placeholder. */
export async function createProjectDirectory(d: Db, user: SessionUser, p: { project_id: string; path: string }) {
  const path = assertSafeProjectPath(p.path);
  return upsertProjectFile(d, user, {
    project_id: p.project_id,
    path: `${path}/.gitkeep`,
    content: "",
    source: "user",
  });
}

export type ProjectAssetGroup = {
  path: string;
  kind: "image" | "font" | "media" | "other";
  bytes: number;
  updated_at: string;
  generated: boolean;
  prompt?: string;
};

/** Asset library (§28): what the project actually owns, grouped for the UI. */
export async function listProjectAssets(d: Db, user: SessionUser, projectId: string) {
  await ownedProject(d, user, projectId);
  const [files, doc] = await Promise.all([
    d.collection("projects").doc(projectId).collection("files").get(),
    d.collection("projects").doc(projectId).get(),
  ]);
  const manifest = Array.isArray(doc.data()?.image_assets) ? (doc.data()?.image_assets as Array<{ path: string; promptHash?: string }>) : [];
  const generatedPaths = new Set(manifest.map((entry) => entry.path));
  const images: ProjectAssetGroup[] = [];
  const other: ProjectAssetGroup[] = [];
  for (const file of files.docs) {
    const path = String(file.data().path ?? "");
    if (!path) continue;
    const content = String(file.data().content ?? "");
    const bytes = file.data().encoding === "base64" ? Math.floor(content.length * 0.75) : content.length;
    const entry: ProjectAssetGroup = {
      path,
      kind: isImagePath(path) ? "image" : /\.(woff2?|ttf|otf|eot)$/i.test(path) ? "font" : /\.(mp3|mp4|webm|wav|ogg)$/i.test(path) ? "media" : "other",
      bytes,
      updated_at: iso(file.data().updated_at),
      generated: generatedPaths.has(path),
    };
    if (entry.kind === "image") images.push(entry);
    else if (entry.kind !== "other") other.push(entry);
  }
  return { images, files: other, generatedCount: images.filter((image) => image.generated).length };
}

export async function loadProjectFiles(d: Db, projectId: string): Promise<ProjectFile[]> {
  const files = await d.collection("projects").doc(projectId).collection("files").get();
  return files.docs.map((doc) =>
    withLanguage({
      path: doc.data().path,
      content: doc.data().content ?? "",
      encoding: doc.data().encoding === "base64" ? "base64" : "utf8",
    }),
  );
}

export function fileDocId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export { slugify };
