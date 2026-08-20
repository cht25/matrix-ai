import "server-only";
import crypto from "node:crypto";
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
    if (mine) return { id: mine.id, title: mine.data().title ?? "Untitled project" };
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
  return { id: created.id, title };
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

async function countImages(d: Db, projectId: string): Promise<number> {
  const files = await d.collection("projects").doc(projectId).collection("files").get();
  return files.docs.reduce((sum, doc) => {
    if (doc.data().encoding === "base64") return sum + String(doc.data().content ?? "").length * 0.75;
    return sum;
  }, 0);
}

export async function upsertProjectFile(
  d: Db,
  user: SessionUser,
  p: { project_id: string; path: string; content: string; encoding?: "utf8" | "base64"; source?: string },
) {
  const { ref } = await ownedProject(d, user, p.project_id);
  const path = assertSafeProjectPath(p.path);
  const encoding = p.encoding === "base64" ? "base64" : "utf8";
  if (encoding === "utf8" && p.content.length > PROJECT_LIMITS.maxTextBytes) throw new RpcError("FILE_TOO_LARGE", 400);
  if (encoding === "base64") {
    const bytes = Math.floor(p.content.length * 0.75);
    if (bytes > PROJECT_LIMITS.maxImageBytes) throw new RpcError("FILE_TOO_LARGE", 400);
  }
  const files = ref.collection("files");
  const existing = await files.where("path", "==", path).limit(1).get();
  if (existing.empty) {
    const all = await files.get();
    if (all.size >= PROJECT_LIMITS.maxFilesPerProject) throw new RpcError("TOO_MANY_FILES", 400);
  }
  if (encoding === "base64" || isImagePath(path)) {
    const used = await countImages(d, p.project_id);
    if (used > PROJECT_LIMITS.maxImageBytesPerProject) throw new RpcError("IMAGE_BUDGET", 400);
  }
  const payload = {
    path,
    content: p.content,
    encoding,
    language: withLanguage({ path, content: p.content, encoding }).language,
    updated_by: p.source === "agent" ? "agent" : "user",
    updated_at: nowTs(),
  };
  if (existing.empty) await files.add({ ...payload, created_at: nowTs() });
  else await existing.docs[0].ref.set(payload, { merge: true });
  const count = (await files.get()).size;
  await ref.set({ file_count: count, updated_at: nowTs() }, { merge: true });
  return { path };
}

export async function deleteProjectFile(d: Db, user: SessionUser, p: { project_id: string; path: string }) {
  const { ref } = await ownedProject(d, user, p.project_id);
  const path = assertSafeProjectPath(p.path);
  const existing = await ref.collection("files").where("path", "==", path).get();
  await Promise.all(existing.docs.map((doc) => doc.ref.delete()));
  const count = (await ref.collection("files").get()).size;
  await ref.set({ file_count: count, updated_at: nowTs() }, { merge: true });
  return true;
}

export async function renameProjectFile(d: Db, user: SessionUser, p: { project_id: string; from: string; to: string }) {
  const from = assertSafeProjectPath(p.from);
  const to = assertSafeProjectPath(p.to);
  const { ref } = await ownedProject(d, user, p.project_id);
  const existing = await ref.collection("files").where("path", "==", from).limit(1).get();
  if (existing.empty) throw new RpcError("NOT_FOUND", 404);
  const clash = await ref.collection("files").where("path", "==", to).limit(1).get();
  if (!clash.empty) throw new RpcError("PATH_EXISTS", 400);
  await existing.docs[0].ref.set({ path: to, updated_at: nowTs(), updated_by: "user" }, { merge: true });
  await ref.set({ updated_at: nowTs() }, { merge: true });
  return true;
}

export async function applyProjectFiles(
  d: Db,
  user: SessionUser,
  p: { project_id: string; files: ProjectFile[]; source?: string; title?: string },
) {
  if (!p.files.length) throw new RpcError("NO_FILES", 400);
  if (p.files.length > PROJECT_LIMITS.maxFilesPerProject) throw new RpcError("TOO_MANY_FILES", 400);
  for (const file of p.files) {
    await upsertProjectFile(d, user, {
      project_id: p.project_id,
      path: file.path,
      content: file.content,
      encoding: file.encoding,
      source: p.source ?? "agent",
    });
  }
  if (p.title) {
    await updateProject(d, user, { id: p.project_id, title: p.title });
  }
  await saveProjectVersion(d, user, {
    project_id: p.project_id,
    source: p.source === "import" ? "import" : "agent",
    summary: `Applied ${p.files.length} file${p.files.length === 1 ? "" : "s"}`,
  });
  return { count: p.files.length };
}

export async function saveProjectVersion(
  d: Db,
  user: SessionUser,
  p: { project_id: string; source: string; summary?: string },
) {
  const { ref } = await ownedProject(d, user, p.project_id);
  const files = await ref.collection("files").get();
  const versions = await ref.collection("versions").get();
  const ordered = versions.docs.sort(descDoc("created_at"));
  if (ordered.length >= PROJECT_LIMITS.maxVersions) {
    const drop = ordered.slice(PROJECT_LIMITS.maxVersions - 1);
    for (const old of drop) {
      const kids = await old.ref.collection("files").listDocuments();
      await Promise.all(kids.map((kid) => kid.delete()));
      await old.ref.delete();
    }
  }
  const version = await ref.collection("versions").add({
    source: p.source,
    summary: (p.summary ?? "").slice(0, 200),
    file_count: files.size,
    created_at: nowTs(),
  });
  await Promise.all(
    files.docs.map((doc) =>
      version.collection("files").add({
        path: doc.data().path,
        content: doc.data().content ?? "",
        encoding: doc.data().encoding ?? "utf8",
      }),
    ),
  );
  return { id: version.id };
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

export async function restoreProjectVersion(d: Db, user: SessionUser, p: { project_id: string; version_id: string }) {
  const { ref } = await ownedProject(d, user, p.project_id);
  await saveProjectVersion(d, user, { project_id: p.project_id, source: "restore", summary: "Snapshot before restore" });
  const version = ref.collection("versions").doc(p.version_id);
  if (!(await version.get()).exists) throw new RpcError("NOT_FOUND", 404);
  const snapshot = await version.collection("files").get();
  const current = await ref.collection("files").get();
  await Promise.all(current.docs.map((doc) => doc.ref.delete()));
  await Promise.all(
    snapshot.docs.map((doc) =>
      ref.collection("files").add({
        path: doc.data().path,
        content: doc.data().content ?? "",
        encoding: doc.data().encoding ?? "utf8",
        language: withLanguage({ path: doc.data().path, content: doc.data().content ?? "" }).language,
        updated_by: "user",
        created_at: nowTs(),
        updated_at: nowTs(),
      }),
    ),
  );
  await ref.set({ file_count: snapshot.size, updated_at: nowTs() }, { merge: true });
  return true;
}

export async function setProjectEnv(d: Db, user: SessionUser, p: { project_id: string; env: Record<string, string> }) {
  const { ref } = await ownedProject(d, user, p.project_id);
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(p.env).slice(0, 30)) {
    const k = key.trim().slice(0, 40);
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
    clean[k] = String(value).slice(0, 500);
  }
  await ref.set({ env_public: clean, updated_at: nowTs() }, { merge: true });
  return { env: clean };
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
