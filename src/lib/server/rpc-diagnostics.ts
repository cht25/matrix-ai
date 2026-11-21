// =============================================================================
// QORVYNA AI — Structured, redacted server diagnostics for /api/rpc.
//
// Design invariants:
//   1. Every /api/rpc invocation carries a stable `request_id` (echoing a
//      validated upstream header/body id or generating a fresh UUID).
//   2. Server logs are structured allowlisted records — never raw exception
//      objects, request bodies, credentials, tokens, cookies, PEM keys, or
//      personally identifiable user fields (emails, names, raw UIDs).
//   3. 5xx error responses never expose internal messages, stack traces, or
//      database details to the client.
// =============================================================================

import crypto from "node:crypto";
import { z } from "zod";
import { isNotConfiguredError } from "@/lib/data";
import { isRpcError } from "@/lib/server/errors";

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "[redacted-pem]"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\s]*/gi, "[redacted-pem]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/matrix_device\.[A-Za-z0-9_.-]+/gi, "matrix_device.[redacted]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  [/__session=[^;\s"']+/gi, "__session=[redacted]"],
  [/(?:sk|gsk|rk|re)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted-key]"],
  [
    /(?:api[_-]?key|authorization|id[_-]?token|access[_-]?token|refresh[_-]?token|claim[_-]?secret|private[_-]?key|client[_-]?secret|cookie|password|secret)\s*[:=]\s*["']?[^\s,"'}]+["']?/gi,
    "[redacted]",
  ],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]"],
];

/** Scrub credentials, tokens, cookies, PEM keys, and emails from a log string. */
export function redactRpcText(input: unknown, maxLen = 280): string {
  let value = String(input ?? "").replace(/[\r\n\t]+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  if (value.length > maxLen) {
    return `${value.slice(0, maxLen)}…`;
  }
  return value;
}

/** Resolve or mint a correlation ID for an /api/rpc request. */
export function resolveRpcRequestId(
  req: Pick<Request, "headers">,
  body?: Record<string, unknown> | null,
): string {
  const candidates = [
    req.headers.get("x-qorvyna-request-id"),
    req.headers.get("x-request-id"),
    typeof body?.request_id === "string" ? body.request_id : null,
    req.headers.get("cf-ray"),
  ];
  for (const raw of candidates) {
    const trimmed = raw?.trim() ?? "";
    if (REQUEST_ID_RE.test(trimmed)) return trimmed;
  }
  return crypto.randomUUID();
}

/** Read-only / idempotent RPC actions safe for a single retry on transient DB transport faults. */
export const READ_ONLY_RPC_ACTIONS = new Set<string>([
  "canvas_list",
  "canvas_get",
  "canvas_versions",
  "onboarding_status",
  "design_current",
  "design_versions",
  "family_list",
  "family_members",
  "family_overview",
  "family_member_detail",
  "family_mirror_status",
  "family_devices",
  "family_mirror_active",
  "device_activity_latest",
  "device_pairing_requests",
  "device_list",
  "device_link_list",
  "device_link_history",
  "device_self",
  "esp32_list",
  "agent_task_list",
  "agent_task_get",
  "reminders_list",
  "mirror_session_signals",
  "mirror_sessions_list",
  "notifications_sync_list",
  "notifications_sync_prefs_get",
  "parent_policy_dashboard",
  "automation_list",
  "automation_scheduler_status",
  "automation_runs_list",
  "notifications_list",
  "usage_summary",
  "project_list",
  "project_get",
  "project_version_list",
  "project_assets",
  "build_run_get",
  "build_run_latest",
  "deployment_overview",
  "deployment_logs",
  "url_list",
  "project_deployment",
  "security_score",
  "inspection_guardian_queue",
  "inspection_active",
  "inspection_detail",
  "conversation_list",
  "conversation_get",
  "settings_get",
  "dashboard_summary",
  "conversation_messages_page",
  "conversation_messages",
]);

/** Extract a normalized upstream/gRPC error code without exposing raw payloads. */
export function extractUpstreamCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const raw = (err as { code?: unknown }).code;
  if (typeof raw === "number") {
    const grpcNames: Record<number, string> = {
      1: "CANCELLED",
      2: "UNKNOWN",
      3: "INVALID_ARGUMENT",
      4: "DEADLINE_EXCEEDED",
      5: "NOT_FOUND",
      6: "ALREADY_EXISTS",
      7: "PERMISSION_DENIED",
      8: "RESOURCE_EXHAUSTED",
      9: "FAILED_PRECONDITION",
      10: "ABORTED",
      13: "INTERNAL",
      14: "UNAVAILABLE",
      16: "UNAUTHENTICATED",
    };
    return grpcNames[raw] ? `GRPC_${raw}_${grpcNames[raw]}` : `CODE_${raw}`;
  }
  if (typeof raw === "string" && raw.trim()) {
    return redactRpcText(raw.trim(), 64);
  }
  return null;
}

/** True when an error is a transient Firestore / network transport interruption. */
export function isTransientFirestoreError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === 14 || code === 4) return true;
  if (typeof code === "string") {
    const normalized = code.toLowerCase();
    if (
      normalized === "unavailable" ||
      normalized === "deadline-exceeded" ||
      normalized === "econnreset" ||
      normalized === "etimedout" ||
      normalized === "epipe"
    ) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return (
    msg.includes("14 unavailable") ||
    msg.includes("4 deadline_exceeded") ||
    msg.includes("rst_stream") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset")
  );
}

export type ClassifiedRpcFailure = {
  code: string;
  status: number;
  detail?: string;
  upstreamCode: string | null;
  category: "rpc" | "validation" | "config" | "upstream_transient" | "upstream_index" | "internal";
};

/** Classify any exception thrown inside /api/rpc into a safe HTTP envelope + log category. */
export function classifyRpcException(err: unknown): ClassifiedRpcFailure {
  const upstreamCode = extractUpstreamCode(err);

  if (isRpcError(err)) {
    return {
      code: err.code,
      status: err.status,
      detail: err.status < 500 ? err.detail : undefined,
      upstreamCode,
      category: "rpc",
    };
  }

  if (err instanceof z.ZodError || (err && typeof err === "object" && (err as { name?: unknown }).name === "ZodError")) {
    return {
      code: "BAD_REQUEST",
      status: 400,
      upstreamCode,
      category: "validation",
    };
  }

  if (isNotConfiguredError(err)) {
    return {
      code: "FIREBASE_NOT_CONFIGURED",
      status: 503,
      upstreamCode,
      category: "config",
    };
  }

  if (isTransientFirestoreError(err)) {
    return {
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      upstreamCode,
      category: "upstream_transient",
    };
  }

  const msg = err instanceof Error ? err.message : "";
  if (upstreamCode === "GRPC_9_FAILED_PRECONDITION" || /requires an index/i.test(msg)) {
    return {
      code: "INTERNAL",
      status: 500,
      upstreamCode: upstreamCode ?? "FAILED_PRECONDITION",
      category: "upstream_index",
    };
  }

  return {
    code: "INTERNAL",
    status: 500,
    upstreamCode,
    category: "internal",
  };
}

function safeStackSummary(err: unknown): string | undefined {
  if (!(err instanceof Error) || typeof err.stack !== "string") return undefined;
  const frames = err.stack
    .split("\n")
    .slice(1, 5)
    .map((line) => redactRpcText(line.trim(), 160))
    .filter(Boolean);
  return frames.length > 0 ? frames.join(" | ") : undefined;
}

export type RpcErrorLogInput = {
  requestId: string;
  action: string;
  status: number;
  code: string;
  category: ClassifiedRpcFailure["category"];
  upstreamCode: string | null;
  authenticated: boolean;
  viaDeviceToken: boolean;
  durationMs: number;
  err: unknown;
};

/** Emit a structured, credential-free diagnostic record for /api/rpc failures. */
export function logRpcFailure(input: RpcErrorLogInput): void {
  const safeAction = redactRpcText(input.action || "unknown", 80) || "unknown";
  const errName =
    input.err instanceof Error
      ? redactRpcText(input.err.name || "Error", 60)
      : typeof input.err;

  if (input.category === "validation") {
    const firstIssue =
      input.err instanceof z.ZodError
        ? input.err.issues[0]?.message
        : input.err instanceof Error
          ? input.err.message
          : "validation failed";
    console.warn(`[QORVYNA] /api/rpc action "${safeAction}" validation failed`, {
      event: "rpc_validation_failed",
      timestamp: new Date().toISOString(),
      route: "/api/rpc",
      request_id: input.requestId,
      action: safeAction,
      http_status: input.status,
      error_code: input.code,
      authenticated: input.authenticated,
      via_device_token: input.viaDeviceToken,
      duration_ms: input.durationMs,
      issue: redactRpcText(firstIssue, 180),
    });
    return;
  }

  const message =
    input.err instanceof Error
      ? redactRpcText(input.err.message, 240)
      : redactRpcText(input.err, 240);

  const record: Record<string, unknown> = {
    event: "rpc_failure",
    timestamp: new Date().toISOString(),
    route: "/api/rpc",
    request_id: input.requestId,
    action: safeAction,
    http_status: input.status,
    error_code: input.code,
    category: input.category,
    upstream_code: input.upstreamCode,
    exception_name: errName,
    authenticated: input.authenticated,
    via_device_token: input.viaDeviceToken,
    duration_ms: input.durationMs,
    message,
  };

  if (input.status >= 500) {
    const stack = safeStackSummary(input.err);
    if (stack) record.stack_top = stack;
    console.error(`[QORVYNA] /api/rpc action "${safeAction}" failed`, record);
    return;
  }

  console.warn(`[QORVYNA] /api/rpc action "${safeAction}" rejected`, record);
}
