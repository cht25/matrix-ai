// Controlled provider execution with capability-aware failover.
//
// Policy (see docs/AI_PLATFORM_OVERHAUL.md):
//   • The first route may be retried once for a transient failure.
//   • ANY provider failure advances to the next eligible route. A failure that
//     belongs to the credential (authentication, billing/quota) or to the
//     request shape for that adapter skips the remaining routes that share the
//     same provider account, because they would fail identically.
//   • Every skipped route is recorded (`attempts`) so the caller can show and
//     log the real active model. A weaker model is never used silently.
//   • Once visible content has been streamed to the browser, the answer is
//     never spliced with a second model's output.
//   • A caller-supplied abort (the user pressed Stop) is never retried.

import type { AIMessage, AIProviderRequest, AIProviderResponse } from "@/lib/ai/groq";
import { AIConfigurationError, type AIRouteTarget } from "@/lib/ai/config";
import { AIProviderError, logProviderFailure, providerErrorFromException } from "@/lib/ai/provider-error";
import { reportModelResult } from "@/lib/ai/model-routing";

export type FailedAttempt = {
  provider: string;
  model: string;
  type: string;
  status: number | null;
  detail: string;
};

export type CompletedAIResponse = {
  target: AIRouteTarget;
  response: AIProviderResponse;
  /** Routes that failed before `target` answered, in order. Empty = primary. */
  attempts: FailedAttempt[];
  /** True when `target` is not the first route that was tried. */
  fallback: boolean;
};

type RequestOptions = Omit<AIProviderRequest, "model" | "messages"> & {
  messages: AIMessage[];
  requestId?: string;
  /**
   * Long generations (whole project files) are read as a stream and
   * aggregated. A fixed total timeout on a blocking request is the wrong
   * tool for a 16k-token answer: slower providers were cut off at 60–90 s
   * while still producing output. The stream is supervised by first-byte and
   * idle watchdogs instead.
   */
  aggregateStream?: boolean;
  /** Absolute epoch-ms budget for the whole call including failover. */
  deadlineAt?: number;
  /** Notified each time a route fails and another one is about to be tried. */
  onFallback?: (failed: FailedAttempt, next: AIRouteTarget) => void;
};

const FIRST_BYTE_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_STREAM_MS = 240_000;
const MIN_ATTEMPT_BUDGET_MS = 12_000;

function asProviderError(target: AIRouteTarget, error: unknown, requestId?: string): AIProviderError {
  return providerErrorFromException(target.provider, target.model, error, requestId);
}

function canTryAgain(error: AIProviderError): boolean {
  // Repeating a timed-out or malformed request only doubles the wait.
  return error.retryable === true && error.type !== "timeout";
}

function scopeOf(target: AIRouteTarget): string {
  return target.providerId ?? target.provider;
}

/** Errors that will repeat for every model behind the same account/adapter. */
function accountScoped(error: AIProviderError): boolean {
  if (error.modelUnavailable) return false;
  return error.type === "authentication" || error.type === "billing" || error.type === "invalid_request";
}

/** Index of the next route worth trying after `error`, or -1. */
export function nextRouteIndex(targets: AIRouteTarget[], index: number, error: AIProviderError): number {
  const skipScope = accountScoped(error) ? scopeOf(targets[index]) : null;
  for (let i = index + 1; i < targets.length; i += 1) {
    if (skipScope && scopeOf(targets[i]) === skipScope) continue;
    return i;
  }
  return -1;
}

function failedAttempt(error: AIProviderError): FailedAttempt {
  return { provider: error.provider, model: error.model, type: error.type, status: error.status, detail: error.detail.slice(0, 200) };
}

function waitBriefly(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

function budgetExhausted(deadlineAt: number | undefined): boolean {
  return typeof deadlineAt === "number" && Date.now() > deadlineAt - MIN_ATTEMPT_BUDGET_MS;
}

/** Read a provider stream to completion under first-byte/idle/total watchdogs. */
async function aggregateStream(target: AIRouteTarget, request: RequestOptions): Promise<AIProviderResponse> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) onOuterAbort();
  request.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const started = Date.now();
  const totalMs = Math.max(MIN_ATTEMPT_BUDGET_MS, Math.min(MAX_STREAM_MS, (request.deadlineAt ?? started + MAX_STREAM_MS) - started));
  let watchdogReason = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (ms: number, reason: string) => {
    if (timer) clearTimeout(timer);
    const remaining = started + totalMs - Date.now();
    const total = remaining <= ms;
    timer = setTimeout(() => {
      watchdogReason = total ? `no complete answer within ${Math.round(totalMs / 1000)}s` : reason;
      controller.abort();
    }, Math.max(1, Math.min(ms, remaining)));
  };
  let content = "";
  let usage: AIProviderResponse["usage"] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  arm(FIRST_BYTE_TIMEOUT_MS, `no output within ${FIRST_BYTE_TIMEOUT_MS / 1000}s of sending the request`);
  try {
    const { aggregateStream: _a, deadlineAt: _d, onFallback: _f, ...providerRequest } = request;
    void _a; void _d; void _f;
    for await (const delta of target.client.streamChat!({
      ...providerRequest,
      model: target.model,
      messages: request.messages,
      signal: controller.signal,
      onUsage: (value) => { usage = value; request.onUsage?.(value); },
      onReasoningActivity: (phase) => {
        arm(IDLE_TIMEOUT_MS, `model stopped responding for ${IDLE_TIMEOUT_MS / 1000}s while reasoning`);
        request.onReasoningActivity?.(phase);
      },
    })) {
      content += delta;
      arm(IDLE_TIMEOUT_MS, `stream stalled for ${IDLE_TIMEOUT_MS / 1000}s after ${content.length} characters`);
    }
  } catch (error) {
    if (watchdogReason && !request.signal?.aborted) {
      throw new AIProviderError({ provider: target.provider, model: target.model, type: "timeout", detail: watchdogReason, requestId: request.requestId });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener("abort", onOuterAbort);
  }
  return { content, model: target.model, usage, finishReason: undefined, toolCalls: [] };
}

/** Completion used by Agent mode, builds and scans. */
export async function completeWithFallback(
  targets: AIRouteTarget[],
  request: RequestOptions,
): Promise<CompletedAIResponse> {
  if (!targets.length) throw new AIConfigurationError(true);
  let lastError: AIProviderError | null = null;
  const attempts: FailedAttempt[] = [];
  let routeIndex = 0;
  let first = true;

  while (routeIndex >= 0 && routeIndex < targets.length) {
    const target = targets[routeIndex];
    const tries = first ? 2 : 1;
    let advanceTo = -1;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (budgetExhausted(request.deadlineAt) && lastError) throw lastError;
      const started = Date.now();
      try {
        const useStream = request.aggregateStream === true && !request.tools?.length && typeof target.client.streamChat === "function";
        let response: AIProviderResponse;
        if (useStream) {
          response = await aggregateStream(target, request);
        } else {
          const { aggregateStream: _a, deadlineAt: _d, onFallback: _f, ...providerRequest } = request;
          void _a; void _d; void _f;
          response = await target.client.chat({ ...providerRequest, model: target.model, messages: request.messages });
        }
        if (!response.content?.trim() && !response.toolCalls?.length) {
          throw new AIProviderError({
            provider: target.provider,
            model: target.model,
            type: "empty_response",
            detail: "provider returned no assistant content",
            requestId: request.requestId,
            retryable: true,
            fallbackEligible: true,
          });
        }
        reportModelResult(target, Date.now() - started);
        return { target, response, attempts, fallback: routeIndex > 0 };
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const typed = asProviderError(target, error, request.requestId);
        lastError = typed;
        reportModelResult(target, Date.now() - started, typed);
        logProviderFailure(typed, request.requestId);
        if (attempt + 1 < tries && canTryAgain(typed)) {
          await waitBriefly();
          continue;
        }
        attempts.push(failedAttempt(typed));
        advanceTo = nextRouteIndex(targets, routeIndex, typed);
        if (advanceTo < 0) throw typed;
        request.onFallback?.(attempts[attempts.length - 1], targets[advanceTo]);
        break;
      }
    }
    first = false;
    routeIndex = advanceTo;
  }
  throw lastError ?? new AIConfigurationError(true);
}

export type StreamRouteCallback = (target: AIRouteTarget, fallback: boolean, failed?: FailedAttempt) => void;

/**
 * Streaming equivalent. A failed upstream is retried once before the
 * fallback. Once any content has been yielded, the response is not silently
 * switched to a second model; the partial output is preserved and the caller
 * receives the real provider error.
 */
export async function* streamWithFallback(
  targets: AIRouteTarget[],
  request: RequestOptions,
  onRoute: StreamRouteCallback,
): AsyncGenerator<{ delta: string; target: AIRouteTarget }> {
  if (!targets.length) throw new AIConfigurationError(false);
  let lastError: AIProviderError | null = null;
  let lastFailed: FailedAttempt | undefined;
  let routeIndex = 0;
  let first = true;

  while (routeIndex >= 0 && routeIndex < targets.length) {
    const target = targets[routeIndex];
    const tries = first ? 2 : 1;
    let advanceTo = -1;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      let yielded = false;
      const started = Date.now();
      try {
        onRoute(target, routeIndex > 0, lastFailed);
        if (!target.client.streamChat) throw new Error("provider does not support streaming");
        const { aggregateStream: _a, deadlineAt: _d, onFallback: _f, ...providerRequest } = request;
        void _a; void _d; void _f;
        for await (const delta of target.client.streamChat({
          ...providerRequest,
          model: target.model,
          messages: request.messages,
        })) {
          yielded = true;
          yield { delta, target };
        }
        if (!yielded) {
          throw new AIProviderError({
            provider: target.provider,
            model: target.model,
            type: "empty_response",
            detail: "provider returned no streamed assistant content",
            requestId: request.requestId,
            retryable: true,
            fallbackEligible: true,
          });
        }
        reportModelResult(target, Date.now() - started);
        return;
      } catch (error) {
        if (request.signal?.aborted) throw error;
        const typed = asProviderError(target, error, request.requestId);
        lastError = typed;
        reportModelResult(target, Date.now() - started, typed);
        logProviderFailure(typed, request.requestId);
        // Do not splice two unrelated answers together after content reached
        // the browser. The route persists the partial answer and reports it.
        if (yielded) throw typed;
        if (attempt + 1 < tries && canTryAgain(typed)) {
          await waitBriefly();
          continue;
        }
        lastFailed = failedAttempt(typed);
        advanceTo = nextRouteIndex(targets, routeIndex, typed);
        if (advanceTo < 0) throw typed;
        request.onFallback?.(lastFailed, targets[advanceTo]);
        break;
      }
    }
    first = false;
    routeIndex = advanceTo;
  }
  throw lastError ?? new AIConfigurationError(false);
}
