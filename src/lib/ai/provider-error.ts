// Provider failures are deliberately typed at the server boundary. The route
// uses these errors to decide whether one retry on the same model is safe, while the
// client only receives a small public error code. Provider response bodies are
// never sent to the browser and are sanitized before they reach logs.

/** Hosts that can serve the one MATRIX model (and the Whisper speech service). */
export type AIProviderName = "Groq" | "OpenAI";

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
  // Unmapped 4xx (proxies/gateways answer with 405, 451, 460…) behave like
  // request-level rejections: retrying verbatim cannot help, so treat them as
  // invalid_request — which is fallback-eligible — instead of the catch-all
  // "unknown" that used to surface to users as the generic "Server problem /
  // could not connect to the AI service" message.
  if (status >= 400) return "invalid_request";
  return "unknown";
}

function parseUpstreamBody(body: string): { detail: string; upstreamType?: string; code?: string } {
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
      const code = typeof error.code === "string" ? error.code : typeof error.code === "number" ? String(error.code) : undefined;
      const type = typeof error.type === "string" ? error.type : undefined;
      return {
        detail: sanitizeProviderDetail([message, code ? `code=${code}` : ""].filter(Boolean).join("; ")),
        upstreamType: type,
        code,
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
  /** Provider's own error code, when it sent one. */
  readonly code?: string;
  /** The provider reports that the model ID itself is unknown/unavailable. */
  readonly modelUnavailable: boolean;

  constructor(opts: {
    code?: string;
    modelUnavailable?: boolean;
    provider: AIProviderName;
    model: string;
    status?: number | null;
    type?: AIProviderErrorType;
    detail: string;
    requestId?: string;
    retryable?: boolean;
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
    this.code = opts.code;
    this.modelUnavailable = opts.modelUnavailable === true;
    this.retryable = opts.retryable ?? ["rate_limit", "provider_unavailable", "timeout", "network", "empty_response"].includes(type);
  }
}

const MODEL_UNAVAILABLE_RE = /(?:model.{0,60}(?:not found|not available|does not exist|unsupported|invalid|no access|not supported|decommissioned|deprecated|no longer)|(?:unknown|invalid) model|is not found for api version|模型不存在|模型.{0,12}(?:不可用|无权|未开通)|no such model)/i;

export function providerErrorFromResponse(
  provider: AIProviderName,
  model: string,
  response: Response,
  body: string,
  requestId?: string,
): AIProviderError {
  const parsed = parseUpstreamBody(body);
  const type = typeForStatus(response.status);
  const requestHeader = response.headers?.get("x-request-id") ?? requestId;
  const modelUnavailable = response.status === 404
    || ((response.status === 400 || response.status === 403) && MODEL_UNAVAILABLE_RE.test(parsed.detail));
  return new AIProviderError({
    provider,
    model,
    status: response.status,
    type: modelUnavailable && type === "authentication" ? "invalid_request" : type,
    detail: parsed.detail,
    requestId: requestHeader ?? undefined,
    code: parsed.code,
    modelUnavailable,
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
  // Structured, greppable provider-failure record. Never contains request
  // contents or key material (detail is sanitized at construction time).
  const record = {
    event: "ai_provider_failure" as const,
    timestamp: new Date().toISOString(),
    route: "/api/ai",
    requestId: requestId ?? "none",
  };
  if (error instanceof AIProviderError) {
    console.error("[MATRIX] AI provider request failed", {
      ...record,
      provider: error.provider,
      model: error.model,
      httpStatus: error.status,
      errorType: error.type,
      requestId: error.requestId ?? requestId ?? "none",
      retryable: error.retryable,
      detail: error.detail,
    });
    return;
  }
  console.error("[MATRIX] AI provider request failed", {
    ...record,
    provider: "unknown",
    model: null,
    httpStatus: null,
    errorType: "unknown",
    detail: sanitizeProviderDetail(error instanceof Error ? error.message : "unknown error"),
  });
}

/** Structured record for NON-provider gateway failures (storage, config…). */
export function logGatewayFailure(scope: string, meta: Record<string, unknown>, error: unknown): void {
  console.error("[MATRIX] gateway failure", {
    event: "ai_gateway_failure",
    timestamp: new Date().toISOString(),
    route: "/api/ai",
    scope,
    ...meta,
    detail: sanitizeProviderDetail(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ),
  });
}
