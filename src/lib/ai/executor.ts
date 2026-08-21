// Controlled provider execution. A primary request may be retried once only
// for transient failures. The configured fallback is tried only for failures
// that cannot be fixed by repeating the same malformed/authenticated request.

import type { AIMessage, AIProviderRequest, AIProviderResponse } from "@/lib/ai/groq";
import { AIConfigurationError, type AIRouteTarget } from "@/lib/ai/config";
import { AIProviderError, logProviderFailure, providerErrorFromException } from "@/lib/ai/provider-error";

export type CompletedAIResponse = {
  target: AIRouteTarget;
  response: AIProviderResponse;
};

type RequestOptions = Omit<AIProviderRequest, "model" | "messages"> & {
  messages: AIMessage[];
  requestId?: string;
};

function asProviderError(target: AIRouteTarget, error: unknown, requestId?: string): AIProviderError {
  return providerErrorFromException(target.provider, target.model, error, requestId);
}

function canTryAgain(error: unknown): boolean {
  return error instanceof Error && "retryable" in error && (error as { retryable?: unknown }).retryable === true;
}

function canFallback(error: unknown): boolean {
  return error instanceof Error && "fallbackEligible" in error && (error as { fallbackEligible?: unknown }).fallbackEligible === true;
}

function waitBriefly(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

/** Non-streaming completion used by Agent mode and scans. */
export async function completeWithFallback(
  targets: AIRouteTarget[],
  request: RequestOptions,
): Promise<CompletedAIResponse> {
  if (!targets.length) throw new AIConfigurationError(true);
  let lastError: unknown = null;

  for (let routeIndex = 0; routeIndex < targets.length; routeIndex += 1) {
    const target = targets[routeIndex];
    const attempts = routeIndex === 0 ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await target.client.chat({
          ...request,
          model: target.model,
          messages: request.messages,
        });
        if (!response.content?.trim()) {
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
        return { target, response };
      } catch (error) {
        const typed = asProviderError(target, error, request.requestId);
        lastError = typed;
        logProviderFailure(typed, request.requestId);
        if (attempt + 1 < attempts && canTryAgain(typed)) {
          await waitBriefly();
          continue;
        }
        if (routeIndex + 1 < targets.length && canFallback(typed)) break;
        throw typed;
      }
    }
    if (lastError && !canFallback(lastError)) throw lastError;
  }
  throw lastError ?? new AIConfigurationError(true);
}

export type StreamRouteCallback = (target: AIRouteTarget, fallback: boolean) => void;

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
  let lastError: unknown = null;

  for (let routeIndex = 0; routeIndex < targets.length; routeIndex += 1) {
    const target = targets[routeIndex];
    const attempts = routeIndex === 0 ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let yielded = false;
      try {
        onRoute(target, routeIndex > 0);
        if (!target.client.streamChat) throw new Error("provider does not support streaming");
        for await (const delta of target.client.streamChat({
          ...request,
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
        return;
      } catch (error) {
        const typed = asProviderError(target, error, request.requestId);
        lastError = typed;
        logProviderFailure(typed, request.requestId);
        // Do not splice two unrelated answers together after content reached
        // the browser. The route persists the partial answer and reports it.
        if (yielded) throw typed;
        if (attempt + 1 < attempts && canTryAgain(typed)) {
          await waitBriefly();
          continue;
        }
        if (routeIndex + 1 < targets.length && canFallback(typed)) break;
        throw typed;
      }
    }
    if (lastError && !canFallback(lastError)) throw lastError;
  }
  throw lastError ?? new AIConfigurationError(false);
}
