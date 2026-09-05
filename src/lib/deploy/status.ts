// =============================================================================
// MATRIX deployment state machine
//
// The UI is only ever allowed to paint a deployment state the backend has
// actually reached (§32, §39). This module is the single source of truth for
// that lifecycle:
//
//   none → queued → building → deploying → live
//                       ↓          ↓
//                     failed      failed → (retry) → queued
//   live → unpublished
//
// `live` can only be entered by a provider that returned a real deployment id
// and a real URL. Nothing here derives state from "a request was sent".
//
// Pure module: no Firestore, no React, no network. Fully unit tested.
// =============================================================================

export type DeploymentStatus =
  | "none"
  | "queued"
  | "building"
  | "deploying"
  | "live"
  | "failed"
  | "unpublished";

/** Every state the platform can actually persist for a deployment. */
export const DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  "none",
  "queued",
  "building",
  "deploying",
  "live",
  "failed",
  "unpublished",
];

const TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  none: ["queued"],
  queued: ["building", "failed"],
  building: ["deploying", "failed"],
  deploying: ["live", "failed"],
  live: ["queued", "unpublished"],
  failed: ["queued", "unpublished"],
  unpublished: ["queued", "none"],
};

/** True when `to` is a legal next state for `from`. */
export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Legal transition or throw. Server code uses this so an impossible state
 * (e.g. jumping straight from `queued` to `live`) is a bug, not a UI lie.
 */
export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`DEPLOYMENT_TRANSITION_INVALID:${from}->${to}`);
  }
}

/** In-flight states — the UI shows a spinner for these and only these. */
export function isActiveStatus(status: DeploymentStatus): boolean {
  return status === "queued" || status === "building" || status === "deploying";
}

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return status === "live" || status === "failed" || status === "unpublished" || status === "none";
}

/** A live URL may only ever be rendered for a deployment that is truly live. */
export function isLive(status: DeploymentStatus): boolean {
  return status === "live";
}

export type StatusCopy = {
  /** Short label used in rows and badges. */
  label: string;
  /** The sentence shown under the label. */
  detail: string;
  glyph: "✓" | "●" | "✕" | "○";
  tone: "neutral" | "active" | "success" | "danger";
};

const COPY: Record<DeploymentStatus, StatusCopy> = {
  none: { label: "Not deployed", detail: "This project has no deployment yet.", glyph: "○", tone: "neutral" },
  queued: { label: "Queued", detail: "Deployment accepted, waiting for the build.", glyph: "○", tone: "active" },
  building: { label: "Building", detail: "Generating, bundling and validating project files.", glyph: "●", tone: "active" },
  deploying: { label: "Publishing...", "detail": "Writing files to the hosting backend.", glyph: "●", tone: "active" },
  live: { label: "Published successfully", detail: "The deployment is live at its public URL.", glyph: "✓", tone: "success" },
  failed: { label: "Publishing failed", detail: "The deployment did not complete. Retry or read the logs.", glyph: "✕", tone: "danger" },
  unpublished: { label: "Unpublished", detail: "The public URL was taken down.", glyph: "○", tone: "neutral" },
};

export function deploymentCopy(status: DeploymentStatus): StatusCopy {
  return COPY[status] ?? COPY.none;
}

/**
 * Coerce untrusted stored/provider values into a known state. Anything the
 * backend wrote that this function cannot recognise becomes `failed`, because
 * an unknown deployment state must never look like success.
 */
export function normalizeStatus(value: unknown): DeploymentStatus {
  const text = String(value ?? "").toLowerCase().trim();
  // Absent means "never deployed"; an unrecognised word means the record cannot
  // be trusted, which is a failure — never a silent success.
  if (!text) return "none";
  if (text === "ready" || text === "active") return "live";
  if (text === "uploading" || text === "activating" || text === "publishing") return "deploying";
  if (text === "publish" || text === "requested" || text === "pending") return "queued";
  if (text === "error" || text === "cancelled" || text === "canceled") return "failed";
  if ((DEPLOYMENT_STATUSES as string[]).includes(text)) return text as DeploymentStatus;
  return "failed";
}
