// User-safe failure taxonomy for every real backend call.
//
// Rules (product spec): never show raw PGRST/Postgres errors, fetch traces,
// Groq payloads or secrets; always produce a professional message and say
// whether a retry can help. Titles match the spec's vocabulary:
// "Server problem", "Authentication failed", etc.

export type ApiFailureKind =
  | "not-configured" // server lacks the Groq/AI configuration
  | "network" // no response at all (offline, DNS, CORS, connection reset)
  | "timeout" // gave up waiting
  | "auth" // 401/403 — session invalid/expired
  | "rate-limit" // 429
  | "invalid-request" // other 4xx — the request itself was rejected
  | "server"; // 5xx / upstream Groq failure

export type ApiFailure = {
  kind: ApiFailureKind;
  /** Short headline shown to the user. */
  title: string;
  /** One or two plain-language sentences. Never technical internals. */
  detail: string;
  /** Whether a [Retry] button is reasonable right now. */
  retryable: boolean;
  /** Suggested follow-up action beyond retry. */
  action?: "sign-in";
};

const FAILURE_COPY: Record<ApiFailureKind, { title: string; detail: string; retryable: boolean }> = {
  "not-configured": {
    title: "Server problem",
    detail: "The AI service is not configured on the server yet. The site administrator needs to finish the backend setup — this is not a problem on your side.",
    retryable: true,
  },
  network: {
    title: "Server problem",
    detail: "MATRIX could not connect to the service. Check your internet connection and try again in a moment.",
    retryable: true,
  },
  timeout: {
    title: "Server problem",
    detail: "The service took too long to respond. It may be busy — please try again in a moment.",
    retryable: true,
  },
  auth: {
    title: "Authentication failed",
    detail: "Your session is no longer valid. Sign in again to continue.",
    retryable: false,
  },
  "rate-limit": {
    title: "Slow down",
    detail: "You've reached the message limit for now. Take a short break, then retry.",
    retryable: true,
  },
  "invalid-request": {
    title: "Server problem",
    detail: "The request could not be processed. If this keeps happening, please contact support.",
    retryable: true,
  },
  server: {
    title: "Server problem",
    detail: "MATRIX could not connect to the AI service right now. Please try again in a moment.",
    retryable: true,
  },
};

export function failureCopy(kind: ApiFailureKind): ApiFailure {
  const base = FAILURE_COPY[kind];
  return { kind, ...base, ...(kind === "auth" ? { action: "sign-in" as const } : {}) };
}

// Server error codes returned by the AI gateway edge function.
const CODE_TO_KIND: Record<string, ApiFailureKind> = {
  AI_GATEWAY_NOT_CONFIGURED: "not-configured",
  CODING_MODEL_NOT_CONFIGURED: "not-configured",
  AI_GATEWAY_ERROR: "server",
  STREAM_FAILED: "server",
  RATE_LIMITED_MINUTE: "rate-limit",
  RATE_LIMITED_DAY: "rate-limit",
  RATE_CHECK_FAILED: "server",
  UNAUTHENTICATED: "auth",
  INVALID_TOKEN: "auth",
  MISSING_TOKEN: "auth",
  STORAGE_OWNERSHIP_VIOLATION: "auth",
};

function kindFromStatus(status: number): ApiFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid-request";
  return "server";
}

/** Map a non-2xx gateway response (status + optional {error} body code) to a user-safe failure. */
export function classifyGatewayResponse(status: number, code?: string | null): ApiFailure {
  if (code && CODE_TO_KIND[code]) return failureCopy(CODE_TO_KIND[code]);
  return failureCopy(kindFromStatus(status));
}

/** Map a fetch()/stream exception to a user-safe failure. */
export function classifyRequestException(err: unknown): ApiFailure {
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return failureCopy("timeout");
  }
  if (err instanceof TypeError) {
    // fetch() rejects with TypeError on network failure (offline, DNS, CORS, reset)
    return failureCopy("network");
  }
  return failureCopy("server");
}
