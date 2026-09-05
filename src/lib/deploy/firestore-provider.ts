// =============================================================================
// MATRIX first-party hosting provider
//
// Implements `DeploymentProvider` on top of the storage the product already
// owns:
//
//   Firestore  projects/<id>                  project meta, urls, live pointer
//   Firestore  projects/<id>/files            the source of truth for project files
//   Firestore  published_sites/<slug>/files   the uploaded, published artefacts
//   Firestore  deployments/<id>               one deployment record + log
//   HTTP       GET /s/<slug>/<path>          the live site (alias_of aware)
//
// Every state change goes through the deployment state machine, so `live` is
// only ever reached after files were really written and the site document was
// really activated. Nothing here can report success without doing the work.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { contentTypeForPath, isValidDeploySlug, slugify, type ProjectFile } from "@/lib/projects/paths";
import { buildPublishedFiles } from "@/lib/projects/bundle";
import { siteOrigin } from "@/lib/seo";
import { assertTransition, normalizeStatus, type DeploymentStatus } from "@/lib/deploy/status";
import { validateProject, type BundleOutcome } from "@/lib/deploy/validate";
import {
  unconfiguredCapabilities,
  DeploymentUnavailableError,
  type BuildProviderResult,
  type DeployInput,
  type DeploymentCapabilities,
  type DeploymentRecord,
  type DeployLogEntry,
  type DomainInput,
  type RollbackInput,
} from "@/lib/deploy/provider";
import { loadProjectFiles } from "@/lib/server/projects";
import { prepareNewUrl, type ProjectUrl, type UrlKind } from "@/lib/deploy/urls";

const MAX_LOG_ENTRIES = 60;
const MAX_SNAPSHOT_FILES = 60;
const MAX_SNAPSHOT_BYTES = 3_000_000;
const PUBLISH_LIMIT_PER_HOUR = 10;

const iso = (value: unknown): string => {
  const ts = value as { toDate?: () => Date } | null | undefined;
  if (ts?.toDate) return ts.toDate().toISOString();
  return typeof value === "string" ? value : "";
};

const byteLength = (file: ProjectFile): number =>
  file.encoding === "base64" ? Math.floor(file.content.length * 0.75) : file.content.length;

/**
 * Real hosting adapter. Credentials never enter this class: it writes through
 * the Admin SDK, whose service account stays server-side (§34).
 */
export class FirestoreDeploymentProvider {
  readonly id = "matrix-static";
  readonly label = "MATRIX hosting";

  constructor(
    private readonly d: Db,
    private readonly user: SessionUser,
  ) {}

  capabilities(): DeploymentCapabilities {
    return {
      ...unconfiguredCapabilities(this.id),
      label: this.label,
      environments: [
        {
          id: "preview",
          label: "Preview",
          supported: true,
          note: "Sandboxed in-app preview served from your project files.",
        },
        {
          id: "staging",
          label: "Staging",
          supported: false,
          note: "This host does not run separate staging environments.",
        },
        {
          id: "production",
          label: "Production",
          supported: true,
          note: "Published at your primary /s/<address> URL.",
        },
      ],
      aliases: true,
      customDomain: "dns_challenge",
      rollback: true,
      logs: true,
      runsBundler: false,
      serverRuntime: false,
      publishRatePerHour: PUBLISH_LIMIT_PER_HOUR,
    };
  }

  // -- build -----------------------------------------------------------------

  async build(projectId: string, files?: ProjectFile[]): Promise<BuildProviderResult> {
    const source = files ?? (await loadProjectFiles(this.d, projectId));
    if (!source.length) {
      return {
        ok: false,
        report: validateProject([], { bundle: { ran: false, reason: "The project has no files yet." } }),
        bundle: { ran: false, reason: "No files to bundle." },
        artifacts: [],
        bytes: 0,
        error: "NO_FILES",
      };
    }
    const envPublic = await this.envPublic(projectId);
    let bundle: BundleOutcome;
    let artifacts: ProjectFile[] = [];
    try {
      const built = buildPublishedFiles(source, envPublic);
      artifacts = built.outFiles;
      if (Object.keys(envPublic).length) {
        artifacts = [
          ...artifacts,
          {
            path: "env.js",
            content: `window.MATRIX_ENV = ${JSON.stringify(envPublic)};`,
            language: "javascript",
            encoding: "utf8",
          },
        ];
      }
      bundle = {
        ran: true,
        ok: artifacts.length > 0,
        outFileCount: artifacts.length,
        inlinedRefs: built.standalone?.inlined ?? 0,
        standalone: built.standalone?.path ?? null,
      };
    } catch (error) {
      bundle = { ran: true, ok: false, error: bundlerMessage(error) };
    }
    const report = validateProject(source, { bundle, envPublic });
    return {
      ok: report.checks.every((check) => check.status !== "failed") && bundle.ran && bundle.ok,
      report,
      bundle,
      artifacts,
      bytes: artifacts.reduce((sum, file) => sum + byteLength(file), 0),
      error: null,
    };
  }

  // -- deploy ----------------------------------------------------------------

  async deploy(input: DeployInput): Promise<DeploymentRecord> {
    await this.assertRateLimit();
    const { ref, data } = await this.ownedProject(input.projectId);

    const sourceFiles = await loadProjectFiles(this.d, input.projectId);
    if (!sourceFiles.length) throw new RpcError("NO_FILES", 400);

    const built = await this.build(input.projectId, sourceFiles);
    const report = input.report ?? built.report;
    if (report.blocking && !input.overridden) throw new RpcError("BUILD_FAILED", 400);
    if (!built.artifacts.length) throw new RpcError("BUILD_EMPTY", 500);

    const slug = await this.resolveSlug(
      input.slug ?? data.live_slug ?? data.title,
      input.slug ? `requested address "${input.slug}"` : "generated from the project title",
    );
    const log: DeployLogEntry[] = [];
    const stamp = (): string => new Date().toISOString();
    const push = (step: DeployLogEntry["step"], detail: string) => {
      const entry: DeployLogEntry = { at: stamp(), step, detail };
      log.push(entry);
      input.onLog?.(entry);
      return entry;
    };

    push("plan", `Preparing deployment (${report.checks.filter((check) => check.status === "passed").length}/${report.checks.length} checks passed).`);
    if (input.overridden && report.blocking) {
      push("warn", "Published with failing checks at the user's explicit request.");
    }

    const version = await this.nextVersion(input.projectId);
    const deploymentRef = await this.d.collection("deployments").add({
      project_id: input.projectId,
      owner_id: this.user.uid,
      run_id: input.runId ?? null,
      status: "building",
      environment: input.environment,
      slug,
      public_url: publicUrl(slug),
      error: "",
      log,
      files: built.artifacts.length,
      bytes: built.bytes,
      overridden: input.overridden === true,
      version,
      rollback_available: false,
      created_at: nowTs(),
      updated_at: nowTs(),
    });
    await this.persistLog(deploymentRef.id, log, "building");

    const siteRef = this.d.collection("published_sites").doc(slug);
    try {
      assertTransition("building", "deploying");
      await deploymentRef.set({ status: "deploying", updated_at: nowTs() }, { merge: true });

      // Replace the previous artefact set, then upload file by file.
      const oldFiles = await safeListDocuments(siteRef);
      await Promise.all(oldFiles.map((file) => file.delete()));
      for (const file of built.artifacts) {
        await siteRef.collection("files").add({
          path: file.path,
          content: file.content,
          encoding: file.encoding ?? "utf8",
          content_type: contentTypeForPath(file.path),
        });
      }
      push("upload", `Wrote ${built.artifacts.length} file${built.artifacts.length === 1 ? "" : "s"} (${formatBytes(built.bytes)}) to MATRIX hosting.`);

      const snapshot = await this.writeSnapshot(deploymentRef.id, built.artifacts, push);
      const previousLive = (data.live_deployment_id as string | undefined) ?? null;
      const siteDoc = await siteRef.get();
      const createdAt = siteDoc.exists ? (siteDoc.data()?.created_at ?? nowTs()) : nowTs();

      await siteRef.set(
        {
          deployment_id: deploymentRef.id,
          project_id: input.projectId,
          alias_of: null,
          owner_id: this.user.uid,
          status: "live",
          slug,
          updated_at: nowTs(),
          created_at: createdAt,
        },
        { merge: true },
      );
      push("activate", `Site live at /s/${slug}`);

      await this.d.collection("projects").doc(input.projectId).set(
        {
          live_slug: slug,
          live_url: publicUrl(slug),
          live_deployment_id: deploymentRef.id,
          live_status: "live",
          updated_at: nowTs(),
        },
        { merge: true },
      );
      await this.syncGeneratedUrls(input.projectId, slug);

      if (previousLive && previousLive !== deploymentRef.id) {
        await this.d
          .collection("deployments")
          .doc(previousLive)
          .set({ status: "unpublished", updated_at: nowTs() }, { merge: true })
          .catch(() => {});
      }

      await deploymentRef.set(
        {
          status: "live",
          rollback_available: snapshot,
          updated_at: nowTs(),
        },
        { merge: true },
      );
      await this.persistLog(deploymentRef.id, log, "live");
      await this.notify(input.projectId, slug);

      return {
        id: deploymentRef.id,
        projectId: input.projectId,
        status: "live",
        slug,
        url: publicUrl(slug),
        environment: input.environment,
        files: built.artifacts.length,
        bytes: built.bytes,
        created_at: stamp(),
        updated_at: stamp(),
        error: null,
        log,
        rollbackAvailable: snapshot,
        overridden: input.overridden === true,
        version,
        runId: input.runId ?? null,
      };
    } catch (error) {
      const message = deploymentMessage(error);
      push("error", message);
      await deploymentRef.set({ status: "failed", error: message, updated_at: nowTs() }, { merge: true }).catch(() => {});
      await this.persistLog(deploymentRef.id, log, "failed");
      await this.d.collection("projects").doc(input.projectId).set({ live_status: "failed", updated_at: nowTs() }, { merge: true }).catch(() => {});
      throw new RpcError(message === "NO_FILES" ? "NO_FILES" : "DEPLOY_FAILED", 500);
    }
  }

  // -- status / listing -------------------------------------------------------

  async getStatus(deploymentId: string, projectId: string): Promise<DeploymentRecord | null> {
    const doc = await this.d.collection("deployments").doc(deploymentId).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    if (data.project_id && data.project_id !== projectId) return null;
    if (data.owner_id && data.owner_id !== this.user.uid) return null;
    return this.toRecord(doc.id, data);
  }

  async getUrl(projectId: string): Promise<string | null> {
    const doc = await this.d.collection("projects").doc(projectId).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    if (data.owner_id !== this.user.uid || data.archived_at) return null;
    if (data.live_status && data.live_status !== "live") return null;
    const slug = (data.live_slug as string) ?? "";
    return slug ? publicUrl(slug) : ((data.live_url as string) ?? null);
  }

  async listDeployments(projectId: string): Promise<DeploymentRecord[]> {
    const snap = await this.d.collection("deployments").where("project_id", "==", projectId).get();
    return snap.docs
      .filter((doc) => doc.data().owner_id === this.user.uid)
      .map((doc) => this.toRecord(doc.id, doc.data()))
      .sort((a, b) => b.version - a.version || b.created_at.localeCompare(a.created_at))
      .slice(0, 20);
  }

  // -- rollback --------------------------------------------------------------

  async rollback(input: RollbackInput): Promise<DeploymentRecord> {
    if (!this.capabilities().rollback) throw new DeploymentUnavailableError("ROLLBACK_NOT_SUPPORTED");
    const { ref, data } = await this.ownedProject(input.projectId);
    const target = await this.d.collection("deployments").doc(input.deploymentId).get();
    if (!target.exists || target.data()?.project_id !== input.projectId || target.data()?.owner_id !== this.user.uid) {
      throw new RpcError("NOT_FOUND", 404);
    }
    const snapshotFiles = await target.ref.collection("files").get();
    if (snapshotFiles.empty) throw new RpcError("ROLLBACK_NOT_SUPPORTED", 400);

    const slug = (data.live_slug as string) || (target.data()?.slug as string) || (await this.resolveSlug(data.title, input.projectId));
    const log: DeployLogEntry[] = [];
    const stamp = (): string => new Date().toISOString();
    const push = (step: DeployLogEntry["step"], detail: string) => {
      const entry: DeployLogEntry = { at: stamp(), step, detail };
      log.push(entry);
      input.onLog?.(entry);
    };

    const version = await this.nextVersion(input.projectId);
    const deploymentRef = await this.d.collection("deployments").add({
      project_id: input.projectId,
      owner_id: this.user.uid,
      run_id: null,
      status: "deploying",
      environment: (target.data()?.environment as DeploymentRecord["environment"]) ?? "production",
      slug,
      public_url: publicUrl(slug),
      error: "",
      log,
      files: snapshotFiles.size,
      bytes: 0,
      overridden: false,
      rollback_of: target.id,
      version,
      rollback_available: false,
      created_at: nowTs(),
      updated_at: nowTs(),
    });

    const siteRef = this.d.collection("published_sites").doc(slug);
    try {
      push("plan", `Rolling back to deployment v${(target.data()?.version as number) ?? "?"} (${snapshotFiles.size} files).`);
      const old = await safeListDocuments(siteRef);
      await Promise.all(old.map((file) => file.delete()));
      let bytes = 0;
      const copies: ProjectFile[] = [];
      for (const doc of snapshotFiles.docs) {
        const file = {
          path: doc.data().path as string,
          content: (doc.data().content as string) ?? "",
          language: "text",
          encoding: (doc.data().encoding === "base64" ? "base64" : "utf8") as "utf8" | "base64",
        };
        bytes += byteLength(file);
        copies.push(file);
        await siteRef.collection("files").add({
          path: file.path,
          content: file.content,
          encoding: file.encoding,
          content_type: doc.data().content_type ?? contentTypeForPath(file.path),
        });
      }
      push("upload", `Re-uploaded ${copies.length} files (${formatBytes(bytes)}).`);
      await siteRef.set(
        { status: "live", deployment_id: deploymentRef.id, project_id: input.projectId, owner_id: this.user.uid, slug, updated_at: nowTs() },
        { merge: true },
      );
      await ref.set({ live_slug: slug, live_url: publicUrl(slug), live_deployment_id: deploymentRef.id, live_status: "live", updated_at: nowTs() }, { merge: true });
      push("activate", `Rolled back deployment is live at /s/${slug}`);
      await deploymentRef.set({ status: "live", bytes, rollback_available: true, updated_at: nowTs() }, { merge: true });
      for (const file of copies) {
        await deploymentRef.collection("files").add({
          path: file.path,
          content: file.content,
          encoding: file.encoding,
          content_type: contentTypeForPath(file.path),
        });
      }
      await this.persistLog(deploymentRef.id, log, "live");
      const fresh = await this.d.collection("deployments").doc(deploymentRef.id).get();
      return this.toRecord(deploymentRef.id, fresh.data() ?? {});
    } catch (error) {
      const message = deploymentMessage(error);
      push("error", message);
      await deploymentRef.set({ status: "failed", error: message, updated_at: nowTs() }, { merge: true }).catch(() => {});
      throw new RpcError("ROLLBACK_FAILED", 500);
    }
  }

  // -- urls / domains --------------------------------------------------------

  async listUrls(projectId: string): Promise<ProjectUrl[]> {
    const { data } = await this.ownedProject(projectId);
    return readStoredUrls(data, projectId);
  }

  async addDomain(input: DomainInput): Promise<ProjectUrl> {
    const { ref, data } = await this.ownedProject(input.projectId);
    const stored = readStoredUrls(data, input.projectId);
    const origin = siteOrigin();
    const validation = prepareNewUrl({
      raw: input.value,
      kind: input.kind,
      origin,
      projectId: input.projectId,
      existing: stored,
    });
    if (!validation.ok) throw new RpcError(validation.code, 400);

    const slug = data.live_slug as string | null | undefined;
    if (validation.kind === "generated") {
      const aliasSlug = validation.slug!;
      if (!isValidDeploySlug(aliasSlug)) throw new RpcError("SLUG_INVALID", 400);
      const existing = await this.d.collection("published_sites").doc(aliasSlug).get();
      if (existing.exists && existing.data()?.owner_id !== this.user.uid) throw new RpcError("SLUG_TAKEN", 409);
      if (!slug) {
        // An alias can only mirror a site that exists: publish first.
        throw new RpcError("NO_LIVE_SITE", 400);
      }
      if (aliasSlug !== slug) {
        await this.d.collection("published_sites").doc(aliasSlug).set(
          {
            alias_of: slug,
            project_id: input.projectId,
            owner_id: this.user.uid,
            status: "live",
            slug: aliasSlug,
            deployment_id: (data.live_deployment_id as string) ?? null,
            created_at: nowTs(),
            updated_at: nowTs(),
          },
          { merge: true },
        );
      }
    }

    if (validation.kind === "custom") {
      const token = crypto.randomBytes(16).toString("hex");
      await ref.set(
        {
          custom_domain: validation.hostname,
          custom_domain_status: "pending_dns",
          custom_domain_token: token,
          updated_at: nowTs(),
        },
        { merge: true },
      );
    }

    const url: ProjectUrl = {
      id: validation.kind === "custom" ? `domain-${validation.hostname}` : validation.kind === "preview" ? "preview" : `slug-${validation.slug}`,
      kind: validation.kind,
      url: validation.url,
      slug: validation.slug,
      hostname: validation.hostname,
      primary: stored.length === 0,
      status: validation.kind === "custom" ? "pending_dns" : "active",
      detail:
        validation.kind === "custom"
          ? "Add a CNAME for this hostname to the MATRIX host, then publish https://" +
            validation.hostname +
            "/.well-known/matrix-domain with the challenge token."
          : validation.kind === "preview"
            ? "Sandboxed preview served from the current project files."
            : "Alias of the same deployment — the host serves it immediately.",
      created_at: new Date().toISOString(),
    };
    await this.saveUrls(input.projectId, [...stored.filter((item) => item.id !== url.id), url]);
    return url;
  }

  async removeDomain(projectId: string, urlId: string): Promise<ProjectUrl[]> {
    const { data } = await this.ownedProject(projectId);
    const stored = readStoredUrls(data, projectId);
    const target = stored.find((item) => item.id === urlId);
    if (!target) throw new RpcError("NOT_FOUND", 404);
    if (target.primary) throw new RpcError("URL_PRIMARY_REQUIRED", 400);
    if (target.kind === "generated" && target.slug) {
      const live = (data.live_slug as string) ?? "";
      if (target.slug !== live) {
        const aliasRef = this.d.collection("published_sites").doc(target.slug);
        if ((await aliasRef.get()).data()?.alias_of) await aliasRef.delete().catch(() => {});
      }
    }
    if (target.kind === "custom") {
      await this.d
        .collection("projects")
        .doc(projectId)
        .set({ custom_domain: "", custom_domain_status: "", custom_domain_token: "", updated_at: nowTs() }, { merge: true });
    }
    const next = stored.filter((item) => item.id !== urlId);
    await this.saveUrls(projectId, next);
    return next;
  }

  async setPrimaryUrl(projectId: string, urlId: string): Promise<ProjectUrl[]> {
    const { ref, data } = await this.ownedProject(projectId);
    const stored = readStoredUrls(data, projectId);
    const target = stored.find((item) => item.id === urlId);
    if (!target) throw new RpcError("NOT_FOUND", 404);
    if (target.kind === "preview") throw new RpcError("URL_NOT_PRIMARY", 400);
    if (target.kind === "custom" && target.status !== "active") throw new RpcError("DOMAIN_NOT_VERIFIED", 400);

    if (target.kind === "generated" && target.slug) {
      const slug = target.slug;
      const siteRef = this.d.collection("published_sites").doc(slug);
      const doc = await siteRef.get();
      const isAlias = Boolean(doc.data()?.alias_of);
      if (isAlias) {
        // Promote the alias: it becomes the real site and the old primary
        // becomes its alias, so both addresses keep working.
        const previous = (data.live_slug as string) ?? "";
        await this.d.collection("published_sites").doc(slug).set({ alias_of: null, status: "live", updated_at: nowTs() }, { merge: true });
        if (previous && previous !== slug) {
          await this.d
            .collection("published_sites")
            .doc(previous)
            .set({ alias_of: slug, project_id: projectId, owner_id: this.user.uid, status: "live", updated_at: nowTs() }, { merge: true });
        }
      }
      await ref.set({ live_slug: slug, live_url: publicUrl(slug), updated_at: nowTs() }, { merge: true });
    }

    const next = stored.map((item) => ({ ...item, primary: item.id === target.id }));
    await this.saveUrls(projectId, next);
    return next;
  }

  /**
   * Verify a custom domain by fetching the challenge file the owner published.
   * Only a real, reachable challenge flips the status to `active` (§7).
   */
  async verifyDomain(projectId: string): Promise<{ status: string; domain: string; detail?: string }> {
    const { ref, data } = await this.ownedProject(projectId);
    const domain = (data.custom_domain as string) ?? "";
    const token = (data.custom_domain_token as string) ?? "";
    if (!domain || !token) throw new RpcError("DOMAIN_NOT_SET", 400);
    let verified = false;
    let detail = "";
    try {
      const res = await fetch(`https://${domain}/.well-known/matrix-domain`, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      const body = (await res.text()).trim();
      verified = res.ok && body.includes(token);
      if (!verified) detail = "The challenge file was not reachable yet.";
    } catch {
      detail = "The challenge file could not be fetched.";
    }
    let status = verified ? "pending_hosting" : "pending_dns";
    if (verified) {
      // Second, stronger check: is anything actually served at that hostname?
      const slug = (data.live_slug as string) ?? "";
      try {
        const probe = await fetch(slug ? `https://${domain}/s/${slug}/` : `https://${domain}/`, { redirect: "follow", signal: AbortSignal.timeout(8000) });
        if (probe.ok) status = "verified";
        else detail = `DNS challenge passed, but ${domain} returned ${probe.status} for the project path.`;
      } catch {
        detail = "DNS challenge passed, but nothing is being served at that hostname yet — attach the domain to the hosting platform too.";
      }
    }
    await ref.set({ custom_domain_status: status, updated_at: nowTs() }, { merge: true });
    const urls = readStoredUrls(data, projectId).map((item) =>
      item.kind === "custom" && item.hostname === domain
        ? {
            ...item,
            status: (status === "verified" ? "active" : "pending_dns") as ProjectUrl["status"],
            detail: status === "verified" ? "Verified: challenge found and the hostname serves this project." : detail || "Verification pending.",
          }
        : item,
    );
    await this.saveUrls(projectId, urls);
    return { status, domain, detail: detail || undefined };
  }

  // -- helpers ---------------------------------------------------------------

  private async envPublic(projectId: string): Promise<Record<string, string>> {
    const doc = await this.d.collection("projects").doc(projectId).get();
    return ((doc.data()?.env_public ?? {}) as Record<string, string>) ?? {};
  }

  private async ownedProject(projectId: string) {
    const ref = this.d.collection("projects").doc(projectId);
    const doc = await ref.get();
    if (!doc.exists || doc.data()?.owner_id !== this.user.uid || doc.data()?.archived_at) throw new RpcError("NOT_FOUND", 404);
    return { ref, data: doc.data() ?? {} };
  }

  private async assertRateLimit(): Promise<void> {
    const snap = await this.d.collection("deployments").where("owner_id", "==", this.user.uid).get();
    const hourAgo = Date.now() - 3_600_000;
    const recent = snap.docs.filter((doc) => (doc.data().created_at?.toDate?.()?.getTime?.() ?? 0) >= hourAgo).length;
    if (recent >= PUBLISH_LIMIT_PER_HOUR) throw new RpcError("PUBLISH_RATE_LIMITED", 429);
  }

  /**
   * Pick the public address. An explicitly requested address is either free,
   * already owned by this user, or a hard SLUG_TAKEN — MATRIX never silently
   * publishes somewhere else than the user asked for.
   */
  private async resolveSlug(input: unknown, origin: string): Promise<string> {
    const requested = origin.startsWith("requested") ? slugify(String(input ?? "")) : "";
    if (requested) {
      if (!isValidDeploySlug(requested)) throw new RpcError("SLUG_INVALID", 400);
      const doc = await this.d.collection("published_sites").doc(requested).get();
      const owner = doc.data()?.owner_id;
      const free = !doc.exists || owner === this.user.uid || Boolean(doc.data()?.alias_of);
      if (!free) throw new RpcError("SLUG_TAKEN", 409);
      return requested;
    }
    const base = slugify(String(input ?? "")) || `site-${crypto.randomBytes(3).toString("hex")}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = attempt ? `${base}-${crypto.randomBytes(2).toString("hex")}`.slice(0, 40) : base;
      if (!isValidDeploySlug(candidate)) continue;
      const doc = await this.d.collection("published_sites").doc(candidate).get();
      if (!doc.exists || doc.data()?.owner_id === this.user.uid || doc.data()?.alias_of) return candidate;
    }
    const fallback = `site-${crypto.randomBytes(4).toString("hex")}`.slice(0, 40);
    if (!isValidDeploySlug(fallback)) throw new RpcError("SLUG_TAKEN", 409);
    return fallback;
  }

  private async nextVersion(projectId: string): Promise<number> {
    const snap = await this.d.collection("deployments").where("project_id", "==", projectId).get();
    const highest = snap.docs.reduce((max, doc) => Math.max(max, Number(doc.data().version ?? 0)), 0);
    return highest + 1;
  }

  private async writeSnapshot(
    deploymentId: string,
    artifacts: ProjectFile[],
    push: (step: DeployLogEntry["step"], detail: string) => void,
  ): Promise<boolean> {
    const bytes = artifacts.reduce((sum, file) => sum + byteLength(file), 0);
    if (artifacts.length > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES) {
      push("upload", `Rollback snapshot skipped (${artifacts.length} files / ${formatBytes(bytes)} exceed the retention budget).`);
      return false;
    }
    const ref = this.d.collection("deployments").doc(deploymentId);
    for (const file of artifacts) {
      await ref.collection("files").add({
        path: file.path,
        content: file.content,
        encoding: file.encoding ?? "utf8",
        content_type: contentTypeForPath(file.path),
      });
    }
    return true;
  }

  private async persistLog(deploymentId: string, log: DeployLogEntry[], status: DeploymentStatus): Promise<void> {
    await this.d
      .collection("deployments")
      .doc(deploymentId)
      .set({ log: log.slice(-MAX_LOG_ENTRIES), status, updated_at: nowTs() }, { merge: true })
      .catch(() => {});
  }

  private async syncGeneratedUrls(projectId: string, slug: string): Promise<void> {
    const doc = await this.d.collection("projects").doc(projectId).get();
    const data = doc.data() ?? {};
    const stored = readStoredUrls(data, projectId);
    const primary: ProjectUrl = {
      id: `slug-${slug}`,
      kind: "generated",
      url: publicUrl(slug),
      slug,
      hostname: "",
      primary: true,
      status: "active",
      detail: "Primary address of this deployment.",
      created_at: new Date().toISOString(),
    };
    const kept = stored.filter((item) => item.id !== primary.id && !(item.kind === "generated" && item.slug === slug));
    const next = [primary, ...kept];
    const hasPrimary = next.some((item) => item.primary);
    await this.saveUrls(projectId, hasPrimary ? next : next.map((item, index) => ({ ...item, primary: index === 0 })));
  }

  private async saveUrls(projectId: string, urls: ProjectUrl[]): Promise<void> {
    await this.d
      .collection("projects")
      .doc(projectId)
      .set({ urls: urls.slice(0, 12), updated_at: nowTs() }, { merge: true });
  }

  private async notify(projectId: string, slug: string): Promise<void> {
    await this.d
      .collection("notifications")
      .add({
        user_id: this.user.uid,
        type: "info",
        title: "Site published",
        body: `Your project is live at /s/${slug}.`,
        link: `/s/${slug}`,
        read_at: null,
        created_at: nowTs(),
      })
      .catch(() => {});
    void projectId;
  }

  private toRecord(id: string, data: Record<string, unknown>): DeploymentRecord {
    const status = normalizeStatus(data.status);
    const slug = (data.slug as string) ?? null;
    return {
      id,
      projectId: (data.project_id as string) ?? "",
      status,
      slug,
      // A URL is only exposed for a deployment the provider reports as live.
      url: status === "live" ? ((data.public_url as string) ?? (slug ? publicUrl(slug) : null)) : null,
      environment: (data.environment as DeploymentRecord["environment"]) ?? "production",
      files: Number(data.files ?? 0),
      bytes: Number(data.bytes ?? 0),
      created_at: iso(data.created_at),
      updated_at: iso(data.updated_at),
      error: (data.error as string) || null,
      log: (Array.isArray(data.log) ? (data.log as DeployLogEntry[]) : []).slice(-MAX_LOG_ENTRIES),
      rollbackAvailable: Boolean(data.rollback_available),
      overridden: Boolean(data.overridden),
      version: Number(data.version ?? 0),
      runId: (data.run_id as string) ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// URL storage shape on the project document
// ---------------------------------------------------------------------------

export function readStoredUrls(data: Record<string, unknown>, projectId: string): ProjectUrl[] {
  const raw = Array.isArray(data.urls) ? (data.urls as Partial<ProjectUrl>[]) : [];
  const urls: ProjectUrl[] = [];
  for (const item of raw) {
    if (!item || typeof item.url !== "string" || !item.url) continue;
    urls.push({
      id: String(item.id ?? `url-${urls.length}`),
      kind: (item.kind === "custom" || item.kind === "preview" || item.kind === "generated" ? item.kind : "generated") as UrlKind,
      url: item.url,
      slug: (item.slug as string) ?? null,
      hostname: (item.hostname as string) ?? "",
      primary: Boolean(item.primary),
      status: (item.status as ProjectUrl["status"]) ?? "active",
      detail: (item.detail as string) ?? "",
      created_at: typeof item.created_at === "string" ? item.created_at : new Date().toISOString(),
    });
  }

  const slug = (data.live_slug as string) ?? "";
  if (slug && !urls.some((item) => item.kind === "generated" && item.slug === slug)) {
    urls.unshift({
      id: `slug-${slug}`,
      kind: "generated",
      url: publicUrl(slug),
      slug,
      hostname: "",
      primary: !urls.some((item) => item.primary),
      status: "active",
      detail: "Primary address of this deployment.",
      created_at: new Date().toISOString(),
    });
  }
  // Preview always exists for a stored project, so it is offered as a URL too.
  if (!urls.some((item) => item.kind === "preview")) {
    urls.push({
      id: "preview",
      kind: "preview",
      url: `/api/projects/${projectId}/preview`,
      slug: null,
      hostname: "",
      primary: false,
      status: "active",
      detail: "Sandboxed preview served from your current project files.",
      created_at: new Date().toISOString(),
    });
  }
  if (urls.length && !urls.some((item) => item.primary)) urls[0] = { ...urls[0], primary: true };
  return urls;
}

export function publicUrl(slug: string): string {
  return `${siteOrigin()}/s/${slug}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

type Deletable = { delete: () => Promise<unknown> };

async function safeListDocuments(ref: unknown): Promise<Deletable[]> {
  try {
    const collection = (ref as { collection: (name: string) => { listDocuments: () => Promise<Deletable[]> } }).collection("files");
    return await collection.listDocuments();
  } catch {
    return [];
  }
}

function bundlerMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 240) || "The bundler could not produce a publishable page.";
}

function deploymentMessage(error: unknown): string {
  if (error instanceof RpcError) return error.code;
  if (error instanceof DeploymentUnavailableError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200) || "DEPLOY_FAILED";
}

export function createProvider(d: Db, user: SessionUser): FirestoreDeploymentProvider {
  return new FirestoreDeploymentProvider(d, user);
}
