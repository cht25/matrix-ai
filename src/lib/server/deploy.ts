// =============================================================================
// MATRIX hosting facade (§4, §5, §7, §8, §17, §18, §21)
//
// This module is the server-side entry point the RPC layer calls. It keeps the
// long-standing function names (`publishProject`, `getDeployment`, …) and now
// delegates every state change to a `DeploymentProvider`, so the hosting
// backend can be swapped without touching the Agent UI (§33).
//
// Provider credentials (the Firebase Admin service account) stay server-side;
// the browser only receives deployment records, URLs and log lines (§34).
// =============================================================================

import "server-only";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { contentTypeForPath, slugify } from "@/lib/projects/paths";
import { siteOrigin } from "@/lib/seo";
import { deploymentCopy, normalizeStatus, type DeploymentStatus } from "@/lib/deploy/status";
import { FirestoreDeploymentProvider, publicUrl, readStoredUrls } from "@/lib/deploy/firestore-provider";
import { filesFromSnippet } from "@/lib/ai/agent";
import { urlErrorCopy, type ProjectUrl, type UrlKind } from "@/lib/deploy/urls";
import type {
  DeploymentCapabilities,
  DeploymentLogResult,
  DeploymentRecord,
  DeploymentRow,
  ProjectDeploymentOverview,
  PublishResult,
  UrlMutationResult,
  ValidationView,
} from "@/lib/deploy/provider";

const iso = (v: unknown): string => {
  const ts = v as { toDate?: () => Date } | null | undefined;
  if (ts?.toDate) return ts.toDate().toISOString();
  return typeof v === "string" ? v : "";
};

function provider(d: Db, user: SessionUser): FirestoreDeploymentProvider {
  return new FirestoreDeploymentProvider(d, user);
}

async function ownedProject(d: Db, user: SessionUser, projectId: string) {
  const ref = d.collection("projects").doc(projectId);
  const doc = await ref.get();
  if (!doc.exists || doc.data()!.owner_id !== user.uid || doc.data()!.archived_at) throw new RpcError("NOT_FOUND", 404);
  return { ref, data: doc.data()! };
}

// ---------------------------------------------------------------------------
// Publish / unpublish
// ---------------------------------------------------------------------------

function toPublishResult(record: DeploymentRecord): PublishResult {
  return {
    id: record.id,
    status: record.status,
    slug: record.slug ?? "",
    public_url: record.url ?? "",
    environment: record.environment,
    files: record.files,
    bytes: record.bytes,
    version: record.version,
    rollback_available: record.rollbackAvailable,
    overridden: record.overridden,
    log: record.log,
  };
}

export async function publishProject(
  d: Db,
  user: SessionUser,
  p: { project_id: string; slug?: string; overridden?: boolean },
): Promise<PublishResult> {
  const record = await provider(d, user).deploy({
    projectId: p.project_id,
    slug: p.slug?.trim() ? slugify(p.slug) : null,
    environment: "production",
    overridden: p.overridden === true,
  });
  return toPublishResult(record);
}

export async function publishSnippet(
  d: Db,
  user: SessionUser,
  p: { lang?: string; code: string; title?: string; slug?: string },
): Promise<PublishResult> {
  const code = p.code.trim();
  if (!code) throw new RpcError("NO_FILES", 400);
  if (code.length > 400_000) throw new RpcError("FILE_TOO_LARGE", 400);
  const { applyProjectFiles, ensureProject } = await import("@/lib/server/projects");
  const files = filesFromSnippet(p.lang ?? "html", code);
  const proj = await ensureProject(d, user, { title: (p.title || "Snippet site").slice(0, 80) });
  await applyProjectFiles(d, user, { project_id: proj.id, files, source: "user", title: p.title });
  return publishProject(d, user, { project_id: proj.id, slug: p.slug });
}

export async function unpublishProject(d: Db, user: SessionUser, projectId: string): Promise<{ status: DeploymentStatus }> {
  const { ref, data } = await ownedProject(d, user, projectId);
  const slug = (data.live_slug as string) ?? "";
  const site = d.collection("published_sites").doc(slug);
  if (slug) {
    const files = await site.collection("files").listDocuments().catch(() => [] as FirebaseFirestore.DocumentReference[]);
    await Promise.all(files.map((file) => file.delete()));
    await site.set({ status: "unpublished", updated_at: nowTs() }, { merge: true });
    // Aliases of this site stop resolving so they cannot serve stale content.
    const aliases = await d.collection("published_sites").where("alias_of", "==", slug).get().catch(() => null);
    if (aliases) {
      await Promise.all(aliases.docs.map((doc) => doc.ref.set({ status: "unpublished", alias_of: null, updated_at: nowTs() }, { merge: true })));
    }
  }
  if (data.live_deployment_id) {
    await d
      .collection("deployments")
      .doc(data.live_deployment_id as string)
      .set({ status: "unpublished", updated_at: nowTs() }, { merge: true })
      .catch(() => {});
  }
  await ref.set({ live_slug: null, live_url: null, live_status: "unpublished", updated_at: nowTs() }, { merge: true });
  return { status: "unpublished" };
}

// ---------------------------------------------------------------------------
// Deployment panel data (§17, §21)
// ---------------------------------------------------------------------------

export async function getDeploymentOverview(d: Db, user: SessionUser, projectId: string): Promise<ProjectDeploymentOverview> {
  const { data } = await ownedProject(d, user, projectId);
  const p = provider(d, user);
  const capabilities = p.capabilities();
  const deployments = await p.listDeployments(projectId);
  const urls = readStoredUrls(data, projectId);
  const liveDeployment = deployments.find((record) => record.status === "live") ?? null;
  const status = liveDeployment ? liveDeployment.status : normalizeStatus(data.live_status ?? (data.live_slug ? "live" : "none"));
  const fileDocs = await d.collection("projects").doc(projectId).collection("files").get().catch(() => null);
  const liveUrl = liveDeployment?.url ?? (data.live_slug ? publicUrl(String(data.live_slug)) : null);
  return {
    status,
    status_label: deploymentCopy(status).label,
    status_detail: deploymentCopy(status).detail,
    environment: liveDeployment?.environment ?? "production",
    live_slug: (data.live_slug as string) ?? null,
    live_url: status === "live" ? liveUrl : null,
    preview_url: `/api/projects/${projectId}/preview`,
    project_id: projectId,
    files: fileDocs?.size ?? Number(data.file_count ?? 0),
    urls,
    deployments: deployments.map(toDeploymentRow),
    capabilities,
    custom_domain: (data.custom_domain as string) ?? "",
    custom_domain_status: (data.custom_domain_status as string) ?? "",
    last_deployed_at: liveDeployment?.updated_at ?? deployments[0]?.updated_at ?? null,
    is_live: status === "live" && Boolean(liveDeployment?.url),
    hosting_configured: true,
  };
}

/** Back-compatible shape consumed by the project workspace. */
export async function getDeployment(d: Db, user: SessionUser, projectId: string) {
  const { data } = await ownedProject(d, user, projectId);
  const deployments = await provider(d, user).listDeployments(projectId);
  return {
    live_slug: data.live_slug ?? null,
    live_url: data.live_slug ? publicUrl(String(data.live_slug)) : null,
    custom_domain: data.custom_domain ?? "",
    custom_domain_status: data.custom_domain_status ?? "",
    deployments: deployments.slice(0, 10).map((record) => ({
      id: record.id,
      status: record.status,
      slug: record.slug,
      public_url: record.url,
      error: record.error ?? "",
      log: record.log,
      created_at: record.created_at,
      files: record.files,
      version: record.version,
      environment: record.environment,
      rollback_available: record.rollbackAvailable,
      overridden: record.overridden,
    })),
  };
}

/**
 * Run the real build checks without publishing anything (§14). Returns the
 * provider's own report, so "Preview/Validate" in the UI is the same verdict a
 * publish would use.
 */
export async function validateProjectBuild(d: Db, user: SessionUser, projectId: string): Promise<ValidationView> {
  await ownedProject(d, user, projectId);
  const built = await provider(d, user).build(projectId);
  return {
    ok: built.ok,
    checks: built.report.checks,
    blocking: built.report.blocking,
    errors: built.report.errors,
    warnings: built.report.warnings,
    summary: built.report.summary,
    artifacts: built.artifacts.length,
    bytes: built.bytes,
    error_text: built.report.blocking
      ? built.report.checks
          .flatMap((check) => check.issues.filter((issue) => issue.severity === "error"))
          .slice(0, 6)
          .map((issue) => `${issue.path}${issue.line ? `:${issue.line}` : ""}  ${issue.message}`)
          .join("\n")
      : "",
  };
}

function toDeploymentRow(record: DeploymentRecord): DeploymentRow {
  return {
    id: record.id,
    status: record.status,
    slug: record.slug,
    public_url: record.url,
    error: record.error ?? "",
    log: record.log,
    created_at: record.created_at,
    files: record.files,
    bytes: record.bytes,
    version: record.version,
    environment: record.environment,
    rollback_available: record.rollbackAvailable,
    overridden: record.overridden,
  };
}

export async function deploymentLogs(d: Db, user: SessionUser, p: { project_id: string; deployment_id?: string }): Promise<DeploymentLogResult> {
  const deployments = await provider(d, user).listDeployments(p.project_id);
  const target = p.deployment_id ? deployments.find((record) => record.id === p.deployment_id) : deployments[0];
  if (!target) throw new RpcError("NOT_FOUND", 404);
  return {
    deployment_id: target.id,
    status: target.status,
    created_at: target.created_at,
    log: target.log.map((entry) => ({ ...entry, time: entry.at.slice(11, 19) })),
  };
}

export async function rollbackDeployment(
  d: Db,
  user: SessionUser,
  p: { project_id: string; deployment_id: string },
): Promise<PublishResult> {
  const capabilities = provider(d, user).capabilities();
  if (!capabilities.rollback) throw new RpcError("ROLLBACK_NOT_SUPPORTED", 400);
  const record = await provider(d, user).rollback({ projectId: p.project_id, deploymentId: p.deployment_id });
  return toPublishResult(record);
}

// ---------------------------------------------------------------------------
// Project URLs (§8, §19, §20)
// ---------------------------------------------------------------------------

export async function listProjectUrls(d: Db, user: SessionUser, projectId: string): Promise<ProjectUrl[]> {
  return provider(d, user).listUrls(projectId);
}

export async function addProjectUrl(
  d: Db,
  user: SessionUser,
  p: { project_id: string; value: string; kind?: UrlKind },
): Promise<UrlMutationResult> {
  const kind: UrlKind = p.kind === "custom" || p.kind === "preview" ? p.kind : "generated";
  if (kind === "custom" && provider(d, user).capabilities().customDomain === "none") {
    throw new RpcError("CUSTOM_DOMAIN_NOT_SUPPORTED", 400);
  }
  const url = await provider(d, user).addDomain({ projectId: p.project_id, value: p.value, kind });
  return { url, urls: await provider(d, user).listUrls(p.project_id) };
}

export async function removeProjectUrl(d: Db, user: SessionUser, p: { project_id: string; url_id: string }): Promise<ProjectUrl[]> {
  return provider(d, user).removeDomain(p.project_id, p.url_id);
}

export async function setPrimaryProjectUrl(
  d: Db,
  user: SessionUser,
  p: { project_id: string; url_id: string },
): Promise<ProjectUrl[]> {
  return provider(d, user).setPrimaryUrl(p.project_id, p.url_id);
}

/** Legacy alias kept for the existing RPC action. */
export async function addProjectDomain(d: Db, user: SessionUser, p: { project_id: string; domain: string }) {
  const url = await provider(d, user).addDomain({ projectId: p.project_id, value: p.domain, kind: "custom" });
  return {
    domain: url.hostname,
    status: url.status === "active" ? "verified" : "pending_dns",
    instructions: url.detail,
    error_copy: urlErrorCopy(null),
  };
}

export async function verifyProjectDomain(d: Db, user: SessionUser, projectId: string) {
  return provider(d, user).verifyDomain!(projectId);
}

export function friendlyUrlError(code: unknown): { title: string; detail: string } {
  return urlErrorCopy(code);
}

// ---------------------------------------------------------------------------
// Admin surfaces (unchanged behaviour)
// ---------------------------------------------------------------------------

export async function adminUnpublishSite(d: Db, slug: string) {
  const site = d.collection("published_sites").doc(slug);
  const doc = await site.get();
  if (!doc.exists) throw new RpcError("NOT_FOUND", 404);
  const files = await site.collection("files").listDocuments().catch(() => [] as FirebaseFirestore.DocumentReference[]);
  await Promise.all(files.map((file) => file.delete()));
  await site.set({ status: "unpublished", updated_at: nowTs() }, { merge: true });
  const projectId = doc.data()?.project_id as string | undefined;
  if (projectId) {
    await d
      .collection("projects")
      .doc(projectId)
      .set({ live_slug: null, live_url: null, live_status: "unpublished", updated_at: nowTs() }, { merge: true });
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
    alias_of: doc.data().alias_of ?? null,
    updated_at: iso(doc.data().updated_at),
    url: `${siteOrigin()}/s/${doc.id}`,
  }));
}

// ---------------------------------------------------------------------------
// Serving published sites (GET /s/<slug>/…)
// ---------------------------------------------------------------------------

/**
 * Resolve a published file. `alias_of` documents serve the primary site's file
 * set, so multiple project URLs (§8) cost zero duplication and can never
 * drift out of sync with the deployment.
 */
export async function loadPublishedFile(d: Db, slug: string, path: string) {
  const site = await d.collection("published_sites").doc(slug).get();
  if (!site.exists || site.data()?.status !== "live") return null;
  const targetSlug = (site.data()?.alias_of as string) || slug;
  const filesRoot = targetSlug === slug ? site.ref : d.collection("published_sites").doc(targetSlug);
  const targetStatus = targetSlug === slug ? null : await d.collection("published_sites").doc(targetSlug).get();
  if (targetSlug !== slug && targetStatus?.data()?.status !== "live") return null;

  const raw = (path || "").replace(/^\.?\/+/, "");
  const wanted = !raw ? "index.html" : raw.endsWith("/") ? `${raw}index.html` : raw;
  const files = await filesRoot.collection("files").get();
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
    (!raw || raw === "index.html" ? files.docs.find((doc) => /(^|\/)index\.html?$/i.test(doc.data().path)) : null);

  if (!match) return null;
  return {
    path: match.data().path as string,
    content: match.data().content as string,
    encoding: (match.data().encoding === "base64" ? "base64" : "utf8") as "utf8" | "base64",
    content_type: (match.data().content_type as string) || contentTypeForPath(match.data().path),
  };
}

/** Health/readiness for the hosting backend: does publishing actually work? */
export async function hostingStatus(d: Db): Promise<{
  configured: boolean;
  provider: string;
  sites_live: number;
  capabilities: DeploymentCapabilities;
}> {
  const live = await d.collection("published_sites").where("status", "==", "live").get().catch(() => null);
  const sample = new FirestoreDeploymentProvider(d, { uid: "__health__", email: null, emailVerified: false });
  return {
    configured: true,
    provider: sample.id,
    sites_live: live?.size ?? 0,
    capabilities: sample.capabilities(),
  };
}

export { slugify, publicUrl };
