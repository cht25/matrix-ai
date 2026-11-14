// User-safe failure taxonomy for every real backend call. Provider details
// stay on the server; the browser receives only a stable category and a safe
// next step.

export type ApiFailureKind =
  | "not-configured"
  | "network"
  | "timeout"
  | "auth" // MATRIX session authentication
  | "provider-auth" // model provider authentication
  | "rate-limit" // MATRIX usage limit
  | "provider-rate-limit"
  | "provider-invalid-request"
  | "provider-unavailable"
  | "billing"
  | "invalid-request"
  | "vision-unsupported" // the model cannot read images
  | "storage" // MATRIX backend (Firestore) unavailable — NOT an AI problem
  | "server";

export type ApiFailure = {
  kind: ApiFailureKind;
  title: string;
  detail: string;
  retryable: boolean;
  action?: "sign-in";
};

const FAILURE_COPY: Record<ApiFailureKind, { title: string; detail: string; retryable: boolean; action?: "sign-in" }> = {
  storage: {
    title: "Chat storage unavailable",
    detail: "MATRIX's chat database is temporarily unreachable, so this message cannot be saved or answered right now. Nothing is wrong on your side — please try again shortly.",
    retryable: true,
  },
  "not-configured": {
    title: "AI service not configured",
    detail: "GPT OSS 120B, the model MATRIX runs on, is not configured on this server. Your message is kept. Ask the administrator to check the provider API key, then retry.",
    retryable: true,
  },
  network: {
    title: "Connection problem",
    detail: "MATRIX could not connect to the service. Check your internet connection and try again in a moment.",
    retryable: true,
  },
  timeout: {
    title: "AI request timed out",
    detail: "GPT OSS 120B took too long to answer. Your message and project are kept — retry.",
    retryable: true,
  },
  auth: {
    title: "Authentication failed",
    detail: "Your MATRIX session is no longer valid. Sign in again to continue.",
    retryable: false,
    action: "sign-in",
  },
  "provider-auth": {
    title: "AI provider authentication failed",
    detail: "MATRIX could not authenticate with the GPT OSS 120B provider. Your message is kept. The administrator needs to check the API key; you can retry once it is fixed.",
    retryable: true,
  },
  "rate-limit": {
    title: "Slow down",
    detail: "You've reached the MATRIX message limit for now. Take a short break, then retry.",
    retryable: true,
  },
  "provider-rate-limit": {
    title: "AI model temporarily rate limited",
    detail: "GPT OSS 120B is temporarily rate limited by its provider. Your message is kept — wait a moment and retry.",
    retryable: true,
  },
  "provider-invalid-request": {
    title: "AI request rejected",
    detail: "GPT OSS 120B rejected this request. Your message is kept — shorten or simplify it and retry.",
    retryable: true,
  },
  "provider-unavailable": {
    title: "AI service temporarily unavailable",
    detail: "GPT OSS 120B is temporarily unavailable. Your message and project are kept — retry in a moment. MATRIX does not switch to a different model.",
    retryable: true,
  },
  billing: {
    title: "AI provider quota reached",
    detail: "The GPT OSS 120B provider account has reached its quota or needs billing attention. Your message is kept. Retry after the administrator resolves it.",
    retryable: true,
  },
  "invalid-request": {
    title: "Request rejected",
    detail: "The request could not be processed. Check the request and try again.",
    retryable: false,
  },
  "vision-unsupported": {
    title: "Images are not supported",
    detail: "GPT OSS 120B is a text model and cannot read images. Remove the image and describe it, or paste the text it contains.",
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
  AI_MODEL_NOT_AVAILABLE: "provider-invalid-request",
  VISION_NOT_CONFIGURED: "vision-unsupported",
  VISION_NOT_SUPPORTED: "vision-unsupported",
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
