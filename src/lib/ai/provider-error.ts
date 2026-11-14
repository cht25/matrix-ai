// Provider failures are deliberately typed at the server boundary. The route
// uses these errors to decide whether a retry/fallback is safe, while the
// client only receives a small public error code. Provider response bodies are
// never sent to the browser and are sanitized before they reach logs.

export type AIProviderName = "GLM" | "OpenRouter" | "Groq" | "OpenAI" | "Gemini" | "Anthropic" | "Ollama";

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
  readonly fallbackEligible: boolean;
  /** Provider's own error code (e.g. GLM "1211"), when it sent one. */
  readonly code?: string;
  /** The model ID itself is unknown/unavailable — other models may still work. */
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
    this.code = opts.code;
    this.modelUnavailable = opts.modelUnavailable === true;
    this.retryable = opts.retryable ?? ["rate_limit", "provider_unavailable", "timeout", "network", "empty_response"].includes(type);
    // 400 malformed requests, authorization, and billing are not model outages.
    // 404 means an unavailable model/endpoint; try another eligible model.
    this.fallbackEligible = opts.fallbackEligible ?? (type !== "authentication" && type !== "billing" && (type !== "invalid_request" || opts.status === 404));
  }
}

/**
 * Zhipu / Z.ai answer business failures with their own numeric codes, often
 * on HTTP 400/429 and (on the mainland gateway) with Chinese messages. The
 * English-only message regex used for OpenAI-style errors never matched them,
 * so "model does not exist" was classified as a malformed request and stopped
 * the Agent instead of advancing to the next model.
 */
export function glmBusinessErrorType(code: string | undefined): { type: AIProviderErrorType; modelUnavailable?: boolean; label: string } | null {
  switch (code) {
    case "1000": case "1001": case "1002": case "1003": case "1004":
      return { type: "authentication", label: "GLM rejected the API key (wrong key, expired token, or key issued for a different gateway/region)" };
    case "1110": case "1111": case "1112": case "1121":
      return { type: "authentication", label: "GLM account is inactive, locked or not permitted to use this API" };
    case "1113":
      return { type: "billing", label: "GLM account has no balance or resource package on this endpoint (Coding Plan keys must use the /api/coding/paas/v4 endpoint)" };
    case "1211": case "1220": case "1221": case "1222":
      return { type: "invalid_request", modelUnavailable: true, label: "GLM model ID does not exist or is not enabled for this account" };
    case "1302": case "1303": case "1305":
      return { type: "rate_limit", label: "GLM rate or concurrency limit reached" };
    case "1304": case "1308": case "1309": case "1310":
      return { type: "billing", label: "GLM usage quota or plan limit reached" };
    case "1301":
      return { type: "invalid_request", label: "GLM content filter rejected the request" };
    default:
      return null;
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
  const business = provider === "GLM" ? glmBusinessErrorType(parsed.code) : null;
  const type = business?.type ?? typeForStatus(response.status);
  const requestHeader = response.headers?.get("x-request-id") ?? response.headers?.get("x-openrouter-request-id") ?? requestId;
  const modelUnavailable = business?.modelUnavailable === true
    || response.status === 404
    || ((response.status === 400 || response.status === 403) && MODEL_UNAVAILABLE_RE.test(parsed.detail));
  return new AIProviderError({
    provider,
    model,
    status: response.status,
    type: modelUnavailable && type === "authentication" ? "invalid_request" : type,
    detail: business ? `${business.label}. Upstream: ${parsed.detail}` : parsed.detail,
    requestId: requestHeader ?? undefined,
    code: parsed.code,
    modelUnavailable,
    fallbackEligible: type === "invalid_request" || modelUnavailable
      ? modelUnavailable
      : type !== "authentication" && type !== "billing",
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
      fallbackEligible: error.fallbackEligible,
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
