// =============================================================================
// MATRIX deployment provider abstraction (§32, §33)
//
//   DeploymentProvider
//        ↓ build()      validate + bundle the project
//        ↓ deploy()     upload files, mint a deployment id
//        ↓ getStatus()  poll the real state
//        ↓ getUrl()     the real live URL
//        ↓ listDeployments() / rollback()
//        ↓ addDomain() / removeDomain() / listUrls() / setPrimaryUrl()
//
// The Agent UI talks to this interface only, so a different host (Firebase App
// Hosting, Cloudflare Pages, S3+CloudFront, Vercel…) can be plugged in without
// rewriting a single component. Provider credentials stay server-side: the
// browser only ever receives deployment records, never tokens.
//
// Honesty rule (§32): when no real hosting backend is configured, the
// `UnavailableDeploymentProvider` below reports no capabilities and refuses to
// deploy. The UI then shows "hosting not configured" — never a fake
// "Published successfully".
// =============================================================================

import type { ProjectFile } from "@/lib/projects/paths";
import type { BuildReport, BundleOutcome } from "@/lib/deploy/validate";
import type { DeploymentStatus } from "@/lib/deploy/status";
import type { BuildCheck } from "@/lib/deploy/validate";
import type { ProjectUrl, UrlKind } from "@/lib/deploy/urls";

export type DeployEnvironmentId = "preview" | "staging" | "production";

export type EnvironmentCapability = {
  id: DeployEnvironmentId;
  label: string;
  /** Only environments the backend really supports are exposed to the UI (§36). */
  supported: boolean;
  note: string;
};

export type DeploymentCapabilities = {
  providerId: string;
  label: string;
  environments: EnvironmentCapability[];
  /** Hosting can serve multiple URLs/aliases for one project (§8). */
  aliases: boolean;
  /** Custom domains need a real DNS challenge (§7). */
  customDomain: "none" | "dns_challenge" | "verified_provider";
  rollback: boolean;
  logs: boolean;
  /** Whether the host compiles a framework build (vite/next) itself. */
  runsBundler: boolean;
  /** Whether the host can serve a server-side runtime (env secrets…). */
  serverRuntime: boolean;
  publishRatePerHour: number | null;
};

export type DeployLogEntry = {
  /** ISO wall-clock time — the UI renders HH:MM:SS from it. */
  at: string;
  step:
    | "plan" | "generate" | "install" | "build" | "validate" | "upload"
    | "activate" | "domain" | "rollback" | "warn" | "error";
  detail: string;
};

export type DeploymentRecord = {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  slug: string | null;
  url: string | null;
  environment: DeployEnvironmentId;
  files: number;
  bytes: number;
  created_at: string;
  updated_at: string;
  error: string | null;
  log: DeployLogEntry[];
  /** Snapshot retention decides whether rollback is offered (§18). */
  rollbackAvailable: boolean;
  /** The user knowingly published despite a failing check (§14 override). */
  overridden: boolean;
  version: number;
  /** Build run that produced this deployment, for chat ↔ deployment links. */
  runId: string | null;
};

export type BuildProviderResult = {
  ok: boolean;
  report: BuildReport;
  bundle: BundleOutcome;
  /** The exact file set that would be uploaded. */
  artifacts: ProjectFile[];
  bytes: number;
  error: string | null;
};

export type DeployInput = {
  projectId: string;
  runId?: string | null;
  /** Requested public address. Validated against the real host state. */
  slug?: string | null;
  environment: DeployEnvironmentId;
  /** Validation report from the pipeline: gates publishing unless overridden. */
  report?: BuildReport | null;
  overridden?: boolean;
  onLog?: (entry: DeployLogEntry) => void;
};

export type RollbackInput = {
  projectId: string;
  deploymentId: string;
  onLog?: (entry: DeployLogEntry) => void;
};

export type DomainInput = {
  projectId: string;
  /** Raw user input (hostname or URL) — validated by the provider. */
  value: string;
  kind: UrlKind;
  onLog?: (entry: DeployLogEntry) => void;
};

export interface DeploymentProvider {
  readonly id: string;
  readonly label: string;
  capabilities(): DeploymentCapabilities;

  /** Validate + bundle without touching the host. Safe to call repeatedly. */
  build(projectId: string, files: ProjectFile[]): Promise<BuildProviderResult>;

  /** Upload a deployment. Resolves with the real provider state and URL. */
  deploy(input: DeployInput): Promise<DeploymentRecord>;

  /** The provider's own view of a deployment — the client polls this. */
  getStatus(deploymentId: string, projectId: string): Promise<DeploymentRecord | null>;

  /** The primary live URL, or null when nothing is live. Never a guess. */
  getUrl(projectId: string): Promise<string | null>;

  listDeployments(projectId: string): Promise<DeploymentRecord[]>;

  /** Only supported when `capabilities().rollback` is true. */
  rollback(input: RollbackInput): Promise<DeploymentRecord>;

  /** Add an alias or custom domain. */
  addDomain(input: DomainInput): Promise<ProjectUrl>;

  removeDomain(projectId: string, urlId: string): Promise<ProjectUrl[]>;

  listUrls(projectId: string): Promise<ProjectUrl[]>;

  setPrimaryUrl(projectId: string, urlId: string): Promise<ProjectUrl[]>;

  /** Pending custom domains only: re-run the DNS/verification challenge. */
  verifyDomain?(projectId: string): Promise<{ status: string; domain: string; detail?: string }>;
}

export class DeploymentUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "DeploymentUnavailableError";
    this.code = code;
  }
}

/** Nothing is supported — the honest default when no host is connected. */
export function unconfiguredCapabilities(providerId = "none"): DeploymentCapabilities {
  return {
    providerId,
    label: "No hosting provider",
    environments: [
      { id: "preview", label: "Preview", supported: false, note: "No preview environment is connected." },
      { id: "staging", label: "Staging", supported: false, note: "Not supported by this backend." },
      { id: "production", label: "Production", supported: false, note: "No hosting provider is configured on this deployment." },
    ],
    aliases: false,
    customDomain: "none",
    rollback: false,
    logs: false,
    runsBundler: false,
    serverRuntime: false,
    publishRatePerHour: null,
  };
}

/**
 * Stand-in provider used when the hosting backend is not configured. Every
 * method fails with a stable code so the UI can explain the situation instead
 * of pretending the project went live (§32).
 */
export class UnconfiguredDeploymentProvider implements DeploymentProvider {
  readonly id = "none";
  readonly label = "No hosting provider";

  capabilities(): DeploymentCapabilities {
    return unconfiguredCapabilities(this.id);
  }

  async build(): Promise<BuildProviderResult> {
    throw new DeploymentUnavailableError("HOSTING_NOT_CONFIGURED");
  }

  async deploy(): Promise<DeploymentRecord> {
    throw new DeploymentUnavailableError("HOSTING_NOT_CONFIGURED");
  }

  async getStatus(): Promise<DeploymentRecord | null> {
    return null;
  }

  async getUrl(): Promise<string | null> {
    return null;
  }

  async listDeployments(): Promise<DeploymentRecord[]> {
    return [];
  }

  async rollback(): Promise<DeploymentRecord> {
    throw new DeploymentUnavailableError("ROLLBACK_NOT_SUPPORTED");
  }

  async addDomain(): Promise<ProjectUrl> {
    throw new DeploymentUnavailableError("CUSTOM_DOMAIN_NOT_SUPPORTED");
  }

  async removeDomain(): Promise<ProjectUrl[]> {
    throw new DeploymentUnavailableError("CUSTOM_DOMAIN_NOT_SUPPORTED");
  }

  async listUrls(): Promise<ProjectUrl[]> {
    return [];
  }

  async setPrimaryUrl(): Promise<ProjectUrl[]> {
    throw new DeploymentUnavailableError("ALIASES_NOT_SUPPORTED");
  }
}

export function isRollbackSupported(capabilities: DeploymentCapabilities): boolean {
  return capabilities.rollback;
}

/** Environments to render in the Deploy dialog — supported ones only (§36). */
export function supportedEnvironments(capabilities: DeploymentCapabilities): EnvironmentCapability[] {
  return capabilities.environments.filter((environment) => environment.supported);
}

// ---------------------------------------------------------------------------
// Shared view models — deliberately declared in this pure module so client
// components can import the exact types the server facade returns without
// pulling a "server-only" module into the browser bundle.
// ---------------------------------------------------------------------------

export type PublishResult = {
  id: string;
  status: DeploymentStatus;
  slug: string;
  public_url: string;
  environment: DeployEnvironmentId;
  files: number;
  bytes: number;
  version: number;
  rollback_available: boolean;
  overridden: boolean;
  log: DeployLogEntry[];
};

export type DeploymentRow = {
  id: string;
  status: DeploymentStatus;
  slug: string | null;
  public_url: string | null;
  error: string;
  log: DeployLogEntry[];
  created_at: string;
  files: number;
  bytes: number;
  version: number;
  environment: DeployEnvironmentId;
  rollback_available: boolean;
  overridden: boolean;
};

export type ProjectDeploymentOverview = {
  status: DeploymentStatus;
  status_label: string;
  status_detail: string;
  environment: DeployEnvironmentId;
  live_slug: string | null;
  live_url: string | null;
  preview_url: string;
  project_id: string;
  files: number;
  urls: ProjectUrl[];
  deployments: DeploymentRow[];
  capabilities: DeploymentCapabilities;
  custom_domain: string;
  custom_domain_status: string;
  last_deployed_at: string | null;
  /** Live only when the provider says so — never inferred from intent (§39). */
  is_live: boolean;
  hosting_configured: boolean;
};

export type DeploymentLogResult = {
  deployment_id: string;
  status: DeploymentStatus;
  created_at: string;
  log: Array<DeployLogEntry & { time: string }>;
};

export type ValidationView = {
  ok: boolean;
  checks: BuildCheck[];
  blocking: boolean;
  errors: number;
  warnings: number;
  summary: string;
  artifacts: number;
  bytes: number;
  error_text: string;
};

export type UrlMutationResult = { url: ProjectUrl; urls: ProjectUrl[] };
