// =============================================================================
// Admin inspection — shared rules (browser-safe, no server imports).
//
// An inspection lets a support engineer look at a device's diagnostic state
// while the person holding the device can SEE it happening. The design encodes
// the spec's hard limits as data:
//
//   • always visible — a native notification names the admin, the reason, the
//     scopes and the duration, and a persistent indicator stays on screen;
//   • never silent, never longer than `max_minutes`;
//   • guardian-protected devices need guardian approval BEFORE anything starts;
//   • nothing that yields a secret is inspectable (`FORBIDDEN_SCOPES`).
// =============================================================================

export const INSPECTION_SCOPES = [
  "app_diagnostics",
  "network_status",
  "storage_usage",
  "notification_health",
  "sync_queue",
  "screen_view",
] as const;

export type InspectionScope = (typeof INSPECTION_SCOPES)[number];

/** Scope labels, written for the person being inspected — not for admins. */
export const SCOPE_LABELS: Record<InspectionScope, string> = {
  app_diagnostics: "App version, crash reports and error logs",
  network_status: "Whether the connection is working",
  storage_usage: "How much storage the app uses",
  notification_health: "Whether notifications arrive",
  sync_queue: "Pending uploads and downloads",
  screen_view: "A live view of your screen (asks again on Android)",
};

/**
 * Things an inspection can NEVER reach. Listed explicitly so a reviewer can
 * see the boundary is a decision, not an omission — and so a new scope cannot
 * quietly widen what is reachable.
 */
export const FORBIDDEN_SCOPES = [
  "messages",
  "chat_history",
  "passwords",
  "tokens",
  "pairing_secrets",
  "camera_without_consent",
  "microphone_without_consent",
  "keystrokes",
  "other_apps",
] as const;

export const INSPECTION_MAX_MINUTES = 30;
export const INSPECTION_DEFAULT_MINUTES = 10;
export const INSPECTION_MIN_REASON = 10;

export type InspectionStatus =
  | "requested"
  | "awaiting_guardian"
  | "approved"
  | "active"
  | "ended"
  | "denied"
  | "expired"
  | "revoked";

export const STATUS_TEXT: Record<InspectionStatus, string> = {
  requested: "Waiting for approval",
  awaiting_guardian: "Waiting for guardian approval",
  approved: "Approved — will start when the device checks in",
  active: "In progress",
  ended: "Finished",
  denied: "Declined",
  expired: "Expired before use",
  revoked: "Stopped by the device owner",
};

export type InspectionRequest = {
  id: string;
  admin_uid: string;
  admin_name: string;
  admin_email: string;
  target_uid: string;
  device_id: string;
  reason: string;
  scopes: InspectionScope[];
  minutes: number;
  status: InspectionStatus;
  created_at: string;
  starts_at: string;
  ends_at: string;
  ended_at: string;
  guardian_required: boolean;
  guardian_uid: string | null;
  stopped_by: string | null;
};

/** Why the request was refused, in words the admin can act on. */
export function validateRequest(input: {
  reason?: string;
  scopes?: unknown;
  minutes?: unknown;
}): { ok: true; reason: string; scopes: InspectionScope[]; minutes: number } | { ok: false; error: string } {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < INSPECTION_MIN_REASON) {
    return { ok: false, error: `Write at least ${INSPECTION_MIN_REASON} characters explaining why this inspection is needed.` };
  }
  const requested = Array.isArray(input.scopes) ? input.scopes.map(String) : [];
  const forbidden = requested.filter((scope) => (FORBIDDEN_SCOPES as readonly string[]).includes(scope));
  if (forbidden.length > 0) {
    return { ok: false, error: `These scopes can never be inspected: ${forbidden.join(", ")}.` };
  }
  const scopes = requested.filter((scope): scope is InspectionScope => (INSPECTION_SCOPES as readonly string[]).includes(scope));
  if (scopes.length === 0) return { ok: false, error: "Choose at least one inspection scope." };
  const minutes = Math.min(INSPECTION_MAX_MINUTES, Math.max(1, Number(input.minutes) || INSPECTION_DEFAULT_MINUTES));
  return { ok: true, reason, scopes, minutes };
}

/** The notice shown on the device — the same words in every surface. */
export function inspectionNotice(request: Pick<InspectionRequest, "admin_name" | "admin_email" | "reason" | "scopes" | "minutes">): string {
  const scopes = request.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join("; ");
  return `${request.admin_name || request.admin_email || "A QORVYNA administrator"} is inspecting this device: ${scopes}. Reason: ${request.reason}. Limited to ${request.minutes} minutes. You can stop it at any time.`;
}

/** Seconds left, clamped — drives the persistent indicator countdown. */
export function secondsRemaining(endsAt: string, now: number = Date.now()): number {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
