import "server-only";
import crypto from "node:crypto";
import { Db, nowTs } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { loadProjectFiles } from "@/lib/server/projects";
import { contentTypeForPath, isValidDeploySlug, slugify, type ProjectFile } from "@/lib/projects/paths";
import { buildPublishedFiles } from "@/lib/projects/bundle";
import { env } from "@/lib/env";

const iso = (v: unknown): string => {
  const ts = v as { toDate?: () => Date } | null | undefined;
  if (ts?.toDate) return ts.toDate().toISOString();
  return typeof v === "string" ? v : "";
};

function origin(): string {
  return (env.appUrl || "http://localhost:3000").replace(/\/$/, "");
}

async function ownedProject(d: Db, user: SessionUser, projectId: string) {
  const ref = d.collection("projects").doc(projectId);
  const doc = await ref.get();
  if (!doc.exists || doc.data()!.owner_id !== user.uid || doc.data()!.archived_at) {
    throw new RpcError("NOT_FOUND", 404);
  }
  return { ref, data: doc.data()! };
}

export async function publishSnippet(
  d: Db,
  user: SessionUser,
  p: { lang?: string; code: string; title?: string; slug?: string },
) {
  const code = p.code.trim();
  if (!code) throw new RpcError("NO_FILES", 400);
  if (code.length > 400_000) throw new RpcError("FILE_TOO_LARGE", 400);
  const { filesFromSnippet } = await import("@/lib/ai/agent");
  const { applyProjectFiles, ensureProject } = await import("@/lib/server/projects");
  const files = filesFromSnippet(p.lang ?? "html", code);
  const proj = await ensureProject(d, user, { title: (p.title || "Snippet site").slice(0, 80) });
  await applyProjectFiles(d, user, { project_id: proj.id, files, source: "user", title: p.title });
  return publishProject(d, user, { project_id: proj.id, slug: p.slug });
}

export async function publishProject(
  d: Db,
  user: SessionUser,
  p: { project_id: string; slug?: string },
) {
  const recent = await d.collection("deployments").where("owner_id", "==", user.uid).get();
  const hourAgo = Date.now() - 3600_000;
  const recentCount = recent.docs.filter((doc) => (doc.data().created_at?.toDate?.()?.getTime?.() ?? 0) >= hourAgo).length;
  if (recentCount >= 10) throw new RpcError("PUBLISH_RATE_LIMITED", 429);

  const { ref, data } = await ownedProject(d, user, p.project_id);
  const files = await loadProjectFiles(d, p.project_id);
  const logs: { at: string; step: string; detail: string }[] = [];
  const stamp = () => new Date().toISOString();
  logs.push({ at: stamp(), step: "validate", detail: `Found ${files.length} project files.` });
  if (!files.length) throw new RpcError("NO_FILES", 400);
  const hasHtml = files.some((file) => /\.html?$/i.test(file.path));
  if (!hasHtml) throw new RpcError("INDEX_REQUIRED", 400);

  let slug = (p.slug || data.live_slug || slugify(data.title || "site") || `site-${crypto.randomBytes(3).toString("hex")}`).toLowerCase();
  slug = slugify(slug) || `site-${crypto.randomBytes(3).toString("hex")}`;
  if (!isValidDeploySlug(slug)) throw new RpcError("SLUG_INVALID", 400);

  const existingSite = await d.collection("published_sites").doc(slug).get();
  if (existingSite.exists && existingSite.data()?.owner_id !== user.uid && existingSite.data()?.status === "live") {
    throw new RpcError("SLUG_TAKEN", 409);
  }
  logs.push({ at: stamp(), step: "snapshot", detail: `Publishing as /s/${slug}` });

  const previous = data.live_deployment_id as string | undefined;
  const deployment = await d.collection("deployments").add({
    project_id: p.project_id,
    owner_id: user.uid,
    status: "building",
    slug,
    public_url: `${origin()}/s/${slug}`,
    error: "",
    log: logs,
    created_at: nowTs(),
    updated_at: nowTs(),
  });

  const siteRef = d.collection("published_sites").doc(slug);
  const oldFiles = await siteRef.collection("files").listDocuments();
  await Promise.all(oldFiles.map((file) => file.delete()));

  const envPublic = (data.env_public ?? {}) as Record<string, string>;

  // The root page is published as ONE self-contained HTML document: every
  // local CSS/JS file is inlined and images/fonts become data: URIs, so the
  // public site at /s/<slug>/ renders completely with no extra requests.
  // Deeper pages and other assets are published unchanged alongside it.
  const bundled = buildPublishedFiles(files, envPublic);
  const publishFiles: ProjectFile[] = bundled.outFiles;
  // Non-root pages and standalone scripts can still load window.MATRIX_ENV.
  if (Object.keys(envPublic).length) {
    publishFiles.push({
      path: "env.js",
      content: `window.MATRIX_ENV = ${JSON.stringify(envPublic)};`,
      language: "javascript",
      encoding: "utf8",
    });
  }

  for (const file of publishFiles) {
    await siteRef.collection("files").add({
      path: file.path,
      content: file.content,
      encoding: file.encoding ?? "utf8",
      content_type: contentTypeForPath(file.path),
    });
  }
  logs.push({
    at: stamp(),
    step: "write",
    detail: `Wrote ${publishFiles.length} files` +
      (bundled.standalone ? ` — ${bundled.standalone.path} is a self-contained page (${bundled.standalone.inlined} CSS/JS/asset references inlined).` : "."),
  });

  await siteRef.set({
    deployment_id: deployment.id,
    project_id: p.project_id,
    owner_id: user.uid,
    status: "live",
    slug,
    updated_at: nowTs(),
    created_at: existingSite.exists ? existingSite.data()?.created_at ?? nowTs() : nowTs(),
  }, { merge: true });

  logs.push({ at: stamp(), step: "activate", detail: "Site is live." });
  await deployment.set({ status: "live", log: logs, updated_at: nowTs() }, { merge: true });
  await ref.set({
    live_slug: slug,
    live_url: `${origin()}/s/${slug}`,
    live_deployment_id: deployment.id,
    updated_at: nowTs(),
  }, { merge: true });

  if (previous && previous !== deployment.id) {
    await d.collection("deployments").doc(previous).set({ status: "unpublished", updated_at: nowTs() }, { merge: true }).catch(() => {});
  }

  await d.collection("notifications").add({
    user_id: user.uid,
    type: "info",
    title: "Site published",
    body: `Your project is live at /s/${slug}.`,
    link: `/s/${slug}`,
    read_at: null,
    created_at: nowTs(),
  });

  return {
    id: deployment.id,
    status: "live",
    slug,
    public_url: `${origin()}/s/${slug}`,
    log: logs,
  };
}

export async function unpublishProject(d: Db, user: SessionUser, projectId: string) {
  const { ref, data } = await ownedProject(d, user, projectId);
  const slug = data.live_slug as string | undefined;
  if (slug) {
    const site = d.collection("published_sites").doc(slug);
    const files = await site.collection("files").listDocuments();
    await Promise.all(files.map((file) => file.delete()));
    await site.set({ status: "unpublished", updated_at: nowTs() }, { merge: true });
  }
  if (data.live_deployment_id) {
    await d.collection("deployments").doc(data.live_deployment_id).set({ status: "unpublished", updated_at: nowTs() }, { merge: true }).catch(() => {});
  }
  await ref.set({ live_slug: null, live_url: null, updated_at: nowTs() }, { merge: true });
  return true;
}

export async function getDeployment(d: Db, user: SessionUser, projectId: string) {
  const { data } = await ownedProject(d, user, projectId);
  const snap = await d.collection("deployments").where("project_id", "==", projectId).get();
  const mine = snap.docs.filter((doc) => doc.data().owner_id === user.uid).sort(descDocSafe);
  return {
    live_slug: data.live_slug ?? null,
    live_url: data.live_url ?? null,
    custom_domain: data.custom_domain ?? "",
    custom_domain_status: data.custom_domain_status ?? "",
    deployments: mine.slice(0, 10).map((doc) => ({
      id: doc.id,
      status: doc.data().status,
      slug: doc.data().slug,
      public_url: doc.data().public_url,
      error: doc.data().error ?? "",
      log: doc.data().log ?? [],
      created_at: iso(doc.data().created_at),
    })),
  };
}

function descDocSafe(a: FirebaseFirestore.QueryDocumentSnapshot, b: FirebaseFirestore.QueryDocumentSnapshot) {
  const at = a.data().created_at?.toDate?.()?.getTime?.() ?? 0;
  const bt = b.data().created_at?.toDate?.()?.getTime?.() ?? 0;
  return bt - at;
}

export async function addProjectDomain(d: Db, user: SessionUser, p: { project_id: string; domain: string }) {
  const { ref } = await ownedProject(d, user, p.project_id);
  const domain = p.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new RpcError("DOMAIN_INVALID", 400);
  const token = crypto.randomBytes(16).toString("hex");
  await ref.set({
    custom_domain: domain,
    custom_domain_status: "pending_dns",
    custom_domain_token: token,
    updated_at: nowTs(),
  }, { merge: true });
  return {
    domain,
    status: "pending_dns",
    token,
    instructions: `Add a CNAME from ${domain} to this MATRIX host, then create https://${domain}/.well-known/matrix-domain containing: ${token}`,
  };
}

export async function verifyProjectDomain(d: Db, user: SessionUser, projectId: string) {
  const { ref, data } = await ownedProject(d, user, projectId);
  const domain = data.custom_domain as string;
  const token = data.custom_domain_token as string;
  if (!domain || !token) throw new RpcError("DOMAIN_NOT_SET", 400);
  try {
    const res = await fetch(`https://${domain}/.well-known/matrix-domain`, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    const body = (await res.text()).trim();
    if (res.ok && body.includes(token)) {
      await ref.set({ custom_domain_status: "verified", updated_at: nowTs() }, { merge: true });
      return { status: "verified", domain };
    }
  } catch {
    /* fall through */
  }
  await ref.set({ custom_domain_status: "pending_dns", updated_at: nowTs() }, { merge: true });
  return { status: "pending_dns", domain, detail: "DNS challenge was not found yet. Keep the CNAME and token file in place." };
}

export async function adminUnpublishSite(d: Db, slug: string) {
  const site = d.collection("published_sites").doc(slug);
  const doc = await site.get();
  if (!doc.exists) throw new RpcError("NOT_FOUND", 404);
  const files = await site.collection("files").listDocuments();
  await Promise.all(files.map((file) => file.delete()));
  await site.set({ status: "unpublished", updated_at: nowTs() }, { merge: true });
  const projectId = doc.data()?.project_id as string | undefined;
  if (projectId) {
    await d.collection("projects").doc(projectId).set({ live_slug: null, live_url: null, updated_at: nowTs() }, { merge: true });
  }
  return true;
}

export async function listLiveSites(d: Db) {
  const snap = await d.collection("published_sites").where("status", "==", "live").get();
  return snap.docs.slice(0, 100).map((doc) => ({
    slug: doc.id,
    owner_id: doc.data().owner_id,
    project_id: doc.data().project_id,
    status: doc.data().status,
    updated_at: iso(doc.data().updated_at),
    url: `${origin()}/s/${doc.id}`,
  }));
}

export async function loadPublishedFile(d: Db, slug: string, path: string) {
  const site = await d.collection("published_sites").doc(slug).get();
  if (!site.exists || site.data()?.status !== "live") return null;
  const raw = (path || "").replace(/^\.?\/+/, "");
  const wanted = !raw ? "index.html" : raw.endsWith("/") ? `${raw}index.html` : raw;
  const files = await site.ref.collection("files").get();
  if (files.empty) return null;

  const normalizedWanted = wanted.toLowerCase();
  const baseName = wanted.split("/").pop()?.toLowerCase() ?? "";

  const match =
    files.docs.find((doc) => doc.data().path === wanted) ??
    files.docs.find((doc) => (doc.data().path || "").replace(/^\.?\/+/, "").toLowerCase() === normalizedWanted) ??
    // Extensionless URLs resolve to the matching .html file (e.g. /about → about.html).
    files.docs.find((doc) => {
      const p = (doc.data().path || "").replace(/^\.?\/+/, "").toLowerCase();
      return p === `${normalizedWanted}.html` || p === `${normalizedWanted}/index.html`;
    }) ??
    files.docs.find((doc) => (doc.data().path || "").split("/").pop()?.toLowerCase() === baseName) ??
    ((!raw || raw === "index.html") ? files.docs.find((doc) => /(^|\/)index\.html?$/i.test(doc.data().path)) : null);

  if (!match) return null;
  return {
    path: match.data().path as string,
    content: match.data().content as string,
    encoding: (match.data().encoding === "base64" ? "base64" : "utf8") as "utf8" | "base64",
    content_type: (match.data().content_type as string) || contentTypeForPath(match.data().path),
  };
}
