// Provider failures are deliberately typed at the server boundary. The route
// uses these errors to decide whether a retry/fallback is safe, while the
// client only receives a small public error code. Provider response bodies are
// never sent to the browser and are sanitized before they reach logs.

export type AIProviderName = "OpenRouter" | "Groq" | "OpenAI";

export type AIProviderErrorType =
  | "authentication"
  | "rate_limit"
  | "invalid_request"
  | "billing"
  | "provider_unavailable"
  | "timeout"
  | "network"
  | "empty_response"
  | "unknown";

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:sk|gsk|key)[-_][A-Za-z0-9._-]+/gi,
  /(?:api[_-]?key|authorization|token|password|secret)\s*[:=]\s*[^,\s}]+/gi,
];

/** Keep diagnostics useful without retaining credentials or large upstream payloads. */
export function sanitizeProviderDetail(input: string): string {
  let value = input.replace(/[\r\n\t]+/g, " ");
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, "[redacted]");
  return value.slice(0, 240).trim();
}

function typeForStatus(status: number): AIProviderErrorType {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "billing";
  if (status === 408 || status === 409 || status === 425 || status === 429) return "rate_limit";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "unknown";
}

function parseUpstreamBody(body: string): { detail: string; upstreamType?: string } {
  if (!body) return { detail: "empty provider error response" };
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; type?: unknown; code?: unknown } | string;
      message?: unknown;
    };
    const error = parsed.error;
    if (typeof error === "string") return { detail: sanitizeProviderDetail(error) };
    if (error && typeof error === "object") {
      const message = typeof error.message === "string" ? error.message : "provider rejected the request";
      const code = typeof error.code === "string" ? error.code : undefined;
      const type = typeof error.type === "string" ? error.type : undefined;
      return {
        detail: sanitizeProviderDetail([message, code ? `code=${code}` : ""].filter(Boolean).join("; ")),
        upstreamType: type,
      };
    }
    return { detail: sanitizeProviderDetail(typeof parsed.message === "string" ? parsed.message : body) };
  } catch {
    return { detail: sanitizeProviderDetail(body) };
  }
}

export class AIProviderError extends Error {
  readonly provider: AIProviderName;
  readonly model: string;
  readonly status: number | null;
  readonly type: AIProviderErrorType;
  readonly detail: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;

  constructor(opts: {
    provider: AIProviderName;
    model: string;
    status?: number | null;
    type?: AIProviderErrorType;
    detail: string;
    requestId?: string;
    retryable?: boolean;
    fallbackEligible?: boolean;
  }) {
    const type = opts.type ?? "unknown";
    super(`${opts.provider} ${type}${opts.status ? ` (${opts.status})` : ""}: ${opts.detail}`);
    this.name = "AIProviderError";
    this.provider = opts.provider;
    this.model = opts.model;
    this.status = opts.status ?? null;
    this.type = type;
    this.detail = sanitizeProviderDetail(opts.detail);
    this.requestId = opts.requestId;
    this.retryable = opts.retryable ?? ["rate_limit", "billing", "provider_unavailable", "timeout", "network", "empty_response"].includes(type);
    // Authentication is a configuration problem; switching providers would
    // hide the operator credential error. Rate limits, billing, capacity,
    // model errors, timeouts and network failures can safely use the configured fallback.
    this.fallbackEligible = opts.fallbackEligible ?? (type !== "authentication");
  }
}

export function providerErrorFromResponse(
  provider: AIProviderName,
  model: string,
  response: Response,
  body: string,
  requestId?: string,
): AIProviderError {
  const parsed = parseUpstreamBody(body);
  const type = typeForStatus(response.status);
  const requestHeader = response.headers?.get("x-request-id") ?? response.headers?.get("x-openrouter-request-id") ?? requestId;
  return new AIProviderError({
    provider,
    model,
    status: response.status,
    type,
    detail: parsed.detail,
    requestId: requestHeader ?? undefined,
  });
}

export function providerErrorFromException(
  provider: AIProviderName,
  model: string,
  error: unknown,
  requestId?: string,
): AIProviderError {
  if (error instanceof AIProviderError) return error;
  const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
  const isAbort = error instanceof DOMException && error.name === "AbortError";
  const type: AIProviderErrorType = isTimeout || isAbort
    ? "timeout"
    : error instanceof TypeError
      ? "network"
      : error instanceof SyntaxError
        ? "provider_unavailable"
        : "unknown";
  const detail = error instanceof Error ? error.message : "provider request failed";
  return new AIProviderError({
    provider,
    model,
    type,
    detail: sanitizeProviderDetail(detail),
    requestId,
  });
}

export function providerPublicCode(error: unknown): string {
  if (!(error instanceof AIProviderError)) return "AI_GATEWAY_ERROR";
  switch (error.type) {
    case "authentication": return "AI_PROVIDER_AUTH_FAILED";
    case "rate_limit": return "AI_PROVIDER_RATE_LIMITED";
    case "billing": return "AI_PROVIDER_BILLING_REQUIRED";
    case "invalid_request": return "AI_INVALID_REQUEST";
    case "timeout": return "AI_REQUEST_TIMEOUT";
    case "provider_unavailable":
    case "network": return "AI_PROVIDER_UNAVAILABLE";
    case "empty_response": return "AI_EMPTY_RESPONSE";
    default: return "AI_GATEWAY_ERROR";
  }
}

export function logProviderFailure(error: unknown, requestId?: string): void {
  if (error instanceof AIProviderError) {
    console.error("[MATRIX] AI provider request failed", {
      provider: error.provider,
      model: error.model,
      httpStatus: error.status,
      errorType: error.type,
      requestId: error.requestId ?? requestId ?? "none",
      detail: error.detail,
    });
    return;
  }
  console.error("[MATRIX] AI provider request failed", {
    provider: "unknown",
    httpStatus: null,
    errorType: "unknown",
    requestId: requestId ?? "none",
    detail: sanitizeProviderDetail(error instanceof Error ? error.message : "unknown error"),
  });
}
