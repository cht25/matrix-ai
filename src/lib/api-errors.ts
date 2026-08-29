// User-safe failure taxonomy for every real backend call. Provider details
// stay on the server; the browser receives only a stable category and a safe
// next step.

export type ApiFailureKind =
  | "not-configured"
  | "network"
  | "timeout"
  | "auth" // MATRIX session authentication
  | "provider-auth" // OpenRouter/Groq authentication
  | "rate-limit" // MATRIX usage limit
  | "provider-rate-limit"
  | "provider-invalid-request"
  | "provider-unavailable"
  | "billing"
  | "invalid-request"
  | "storage" // MATRIX backend (Firestore) unavailable — NOT an AI problem
  | "server";

export type ApiFailure = {
  kind: ApiFailureKind;
  title: string;
  detail: string;
  retryable: boolean;
  action?: "sign-in" | "try-model";
};

const FAILURE_COPY: Record<ApiFailureKind, { title: string; detail: string; retryable: boolean; action?: "sign-in" | "try-model" }> = {
  storage: {
    title: "Chat storage unavailable",
    detail: "MATRIX's chat database is temporarily unreachable, so this message cannot be saved or answered right now. Nothing is wrong on your side — please try again shortly.",
    retryable: true,
  },
  "not-configured": {
    title: "AI service not configured",
    detail: "The AI service is not configured on the server yet. The site administrator needs to finish the backend setup — this is not a problem on your side.",
    retryable: true,
  },
  network: {
    title: "Connection problem",
    detail: "MATRIX could not connect to the service. Check your internet connection and try again in a moment.",
    retryable: true,
  },
  timeout: {
    title: "AI request timed out",
    detail: "The AI request took too long to finish. Please try again.",
    retryable: true,
    action: "try-model",
  },
  auth: {
    title: "Authentication failed",
    detail: "Your MATRIX session is no longer valid. Sign in again to continue.",
    retryable: false,
    action: "sign-in",
  },
  "provider-auth": {
    title: "AI provider authentication failed",
    detail: "MATRIX could not authenticate with the selected AI provider. Please try another model or contact the administrator.",
    retryable: false,
    action: "try-model",
  },
  "rate-limit": {
    title: "Slow down",
    detail: "You've reached the MATRIX message limit for now. Take a short break, then retry.",
    retryable: true,
  },
  "provider-rate-limit": {
    title: "AI model temporarily rate limited",
    detail: "The selected AI model is temporarily rate limited. MATRIX can try another configured model.",
    retryable: true,
    action: "try-model",
  },
  "provider-invalid-request": {
    title: "AI request rejected",
    detail: "The selected AI model rejected this request. Try another model or simplify the request.",
    retryable: false,
    action: "try-model",
  },
  "provider-unavailable": {
    title: "AI service temporarily unavailable",
    detail: "The selected AI provider is temporarily unavailable. Please try again or use another model.",
    retryable: true,
    action: "try-model",
  },
  billing: {
    title: "AI model needs billing",
    detail: "The selected AI model is not available on this provider account. MATRIX can try another configured model.",
    retryable: false,
    action: "try-model",
  },
  "invalid-request": {
    title: "Request rejected",
    detail: "The request could not be processed. Check the request and try again.",
    retryable: false,
  },
  server: {
    title: "Server problem",
    detail: "Something went wrong on MATRIX's server while handling this request. The error has been logged. Please try again in a moment.",
    retryable: true,
  },
};

export function failureCopy(kind: ApiFailureKind): ApiFailure {
  return { kind, ...FAILURE_COPY[kind] };
}

const CODE_TO_KIND: Record<string, ApiFailureKind> = {
  AI_GATEWAY_NOT_CONFIGURED: "not-configured",
  CODING_MODEL_NOT_CONFIGURED: "not-configured",
  CHAT_STORAGE_UNAVAILABLE: "storage",
  SCAN_STORAGE_UNAVAILABLE: "storage",
  AI_PROVIDER_AUTH_FAILED: "provider-auth",
  AI_PROVIDER_RATE_LIMITED: "provider-rate-limit",
  AI_PROVIDER_BILLING_REQUIRED: "billing",
  AI_INVALID_REQUEST: "provider-invalid-request",
  AI_REQUEST_TIMEOUT: "timeout",
  AI_PROVIDER_UNAVAILABLE: "provider-unavailable",
  AI_EMPTY_RESPONSE: "provider-unavailable",
  AI_GATEWAY_ERROR: "server",
  STREAM_FAILED: "server",
  RATE_LIMITED_MINUTE: "rate-limit",
  RATE_LIMITED_DAY: "rate-limit",
  RATE_CHECK_FAILED: "server",
  DUPLICATE_REQUEST: "invalid-request",
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

/** Map a non-2xx gateway response (status + optional {error} body code). */
export function classifyGatewayResponse(status: number, code?: string | null): ApiFailure {
  if (code && CODE_TO_KIND[code]) return failureCopy(CODE_TO_KIND[code]);
  return failureCopy(kindFromStatus(status));
}

/** Map a fetch()/stream exception to a user-safe failure. */
export function classifyRequestException(err: unknown): ApiFailure {
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return failureCopy("timeout");
  }
  if (err instanceof TypeError) return failureCopy("network");
  return failureCopy("server");
}

/** Attach a short correlation reference so an operator can find the exact
 * structured log entry (server logs never contain secrets or message text). */
export function withRequestReference(failure: ApiFailure, requestId: string | null | undefined): ApiFailure {
  if (!requestId) return failure;
  const short = requestId.length > 12 ? requestId.slice(0, 12) : requestId;
  if (failure.detail.includes(short)) return failure;
  return { ...failure, detail: `${failure.detail} (reference ${short})` };
}
