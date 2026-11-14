// =============================================================================
// Generic OpenAI-compatible provider.
//
// Used only for the optional dedicated GPT OSS 120B endpoint
// (GPT_OSS_BASE_URL + GPT_OSS_API_KEY, see config.ts): an OpenAI-compatible
// base URL (".../v1" or a full ".../chat/completions") serving the same model.
//
// The API key is server-only and is never returned to the browser.
// =============================================================================

import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  AIProviderToolCall,
} from "@/lib/ai/groq";
import { AIProviderError, providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { assistantContentOnly, assistantDeltaContent, createReasoningStreamFilter, hasReasoningDelta } from "@/lib/ai/reasoning";
import { fetchModelCatalog, verifyCatalogModel } from "@/lib/ai/model-catalog";
import { cachedRealHealthCheck, healthCacheKey } from "@/lib/ai/provider-health";

/** Strip a full chat-completions URL down to the API base URL. */
export function normalizeCompatibleBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withoutPath = trimmed
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/completions$/i, "")
    .trim()
    .replace(/\/+$/, "");
  return withoutPath;
}

/** A rough sanity check for endpoint URLs; still validated in the RPC layer. */
export function isCompatibleBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return url.pathname.length <= 300;
  } catch {
    return false;
  }
}

function isReasoningModel(model: string): boolean {
  return /gpt-oss/i.test(model);
}

function parseToolCalls(value: unknown): AIProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const call = entry as Record<string, unknown>;
    const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
    if (typeof call.id !== "string" || !call.id.trim() || typeof fn?.name !== "string" || typeof fn.arguments !== "string") return [];
    return [{ id: call.id.slice(0, 128), type: "function" as const, function: { name: fn.name.slice(0, 64), arguments: fn.arguments.slice(0, 12_000) } }];
  });
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly providerName = "OpenAI";
  readonly supportsToolCalls = true;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string,
    private readonly label = "OpenAI-compatible",
    /** Model used for the honest one-token health probe (the admin chat model). */
    private readonly healthCheckModel?: string,
  ) {
    this.baseUrl = normalizeCompatibleBaseUrl(baseUrl);
    if (!this.baseUrl) throw new Error("OpenAI-compatible base URL is required");
  }

  private headers(requestId?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...(requestId ? { "X-Request-ID": requestId } : {}),
    };
  }

  private buildMessages(req: AIProviderRequest): Record<string, unknown>[] {
    if (!req.imageDataUrl) return req.messages.map((message) => ({ ...message }));
    const last = req.messages[req.messages.length - 1];
    if (!last) return req.messages.map((message) => ({ ...message }));
    return [
      ...req.messages.slice(0, -1).map((message) => ({ ...message })),
      {
        role: last.role,
        content: [
          { type: "text", text: last.content },
          { type: "image_url", image_url: { url: req.imageDataUrl } },
        ],
      },
    ];
  }

  private buildBody(req: AIProviderRequest, stream: boolean): Record<string, unknown> {
    const maxTokens = req.maxTokens ?? 1024;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: this.buildMessages(req),
      temperature: req.temperature ?? 0.5,
      max_tokens: maxTokens,
      stream,
    };
    // Newer OpenAI-compatible reasoning models prefer max_completion_tokens.
    if (isReasoningModel(req.model)) {
      body.max_completion_tokens = maxTokens;
    }
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }
    return body;
  }

  async listModels() { return (await fetchModelCatalog({ baseUrl: this.baseUrl, apiKey: this.apiKey })).models; }
  async verifyModel(model: string) { await verifyCatalogModel({ baseUrl: this.baseUrl, apiKey: this.apiKey }, model); }

  async healthCheck(): Promise<boolean> {
    // A real one-token completion against the configured model. GET /models is
    // answered 200 by many proxies WITHOUT a valid key, which
    // used to report "AI Online" while every actual chat request failed.
    // The body mirrors buildBody() (max_completion_tokens only for reasoning
    // models) so the probe can never pass while the real chat shape fails.
    const model = this.healthCheckModel ?? "";
    const probe = async () => {
      try {
        const body: Record<string, unknown> = {
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        };
        if (isReasoningModel(model)) body.max_completion_tokens = 1;
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
        redirect: "error",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) return { ok: true, status: response.status, detail: "ok" };
        const detail = await response.text().catch(() => "");
        return { ok: false, status: response.status, detail };
      } catch (error) {
        return { ok: false, status: null, detail: error instanceof Error ? error.message : "network error" };
      }
    };
    const result = await cachedRealHealthCheck(healthCacheKey(["openai", this.baseUrl, this.healthCheckModel, this.apiKey.slice(-4)]), probe);
    if (!result.ok && result.status) {
      // Operators need the REAL reason the provider is down. Sanitized: no key
      // material, no large upstream payloads.
      console.error("[MATRIX] AI provider health check failed", {
        provider: "OpenAI-compatible",
        baseUrl: this.baseUrl,
        model: this.healthCheckModel ?? "(chat model)",
        httpStatus: result.status,
        detail: result.detail.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]").slice(0, 240),
      });
    }
    return result.ok;
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: this.headers(req.requestId),
        body: JSON.stringify(this.buildBody(req, false)),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw providerErrorFromException("OpenAI", req.model, error, req.requestId);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw providerErrorFromResponse("OpenAI", req.model, response, detail, req.requestId);
    }

    let data: {
      choices?: { message?: { content?: unknown; tool_calls?: AIProviderToolCall[] }; finish_reason?: string }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw providerErrorFromException("OpenAI", req.model, error, req.requestId);
    }
    return {
      content: assistantContentOnly(data.choices?.[0]?.message),
      model: data.model ?? req.model,
      finishReason: data.choices?.[0]?.finish_reason,
      toolCalls: parseToolCalls(data.choices?.[0]?.message?.tool_calls),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: this.headers(req.requestId),
        body: JSON.stringify(this.buildBody(req, true)),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        if (!response.ok) throw providerErrorFromResponse("OpenAI", req.model, response, detail, req.requestId);
        throw new Error("OpenAI-compatible endpoint returned an empty stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      // Reasoning deltas are dropped via assistantDeltaContent, and inline
      // <think> blocks that span several deltas are removed
      // by the stateful filter — without trimming a single space or newline
      // off the visible text. Per-delta trimming is what used to glue every
      // word together into unreadable output.
      let reasoningStarted = false;
      let reasoningFinished = false;
      const reasoningFilter = createReasoningStreamFilter();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            sawDone = true;
            if (reasoningStarted && !reasoningFinished) {
              reasoningFinished = true;
              req.onReasoningActivity?.("done");
            }
            const tail = reasoningFilter.flush();
            if (tail) yield tail;
            return;
          }
          try {
            const event = JSON.parse(payload) as {
              error?: { message?: string };
              choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            if (event.usage) {
              const promptTokens = event.usage.prompt_tokens ?? 0;
              const completionTokens = event.usage.completion_tokens ?? 0;
              req.onUsage?.({ promptTokens, completionTokens, totalTokens: event.usage.total_tokens ?? promptTokens + completionTokens });
            }
            if (event.error) {
              throw new AIProviderError({
                provider: "OpenAI",
                model: req.model,
                type: "provider_unavailable",
                detail: event.error.message ?? "OpenAI-compatible stream error",
                requestId: req.requestId,
              });
            }
            const deltaObj = event.choices?.[0]?.delta;
            if (hasReasoningDelta(deltaObj)) {
              if (!reasoningStarted) {
                reasoningStarted = true;
                req.onReasoningActivity?.("start");
              } else {
                req.onReasoningActivity?.("delta");
              }
            }
            // Drop reasoning/chain-of-thought deltas so the user only ever sees
            // the real answer while signaling live step activity.
            const visible = reasoningFilter.push(assistantDeltaContent(deltaObj));
            if (visible) {
              if (reasoningStarted && !reasoningFinished) {
                reasoningFinished = true;
                req.onReasoningActivity?.("done");
              }
              yield visible;
            }
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }
      if (!sawDone) {
        throw new AIProviderError({
          provider: "OpenAI",
          model: req.model,
          type: "provider_unavailable",
          detail: "provider stream ended before [DONE]",
          requestId: req.requestId,
        });
      }
    } catch (error) {
      throw providerErrorFromException("OpenAI", req.model, error, req.requestId);
    }
  }
}

/**
 * Build a provider directly from an admin-configured record.
 * Callers should only pass an object returned by the runtime config loader.
 */
export function createOpenAICompatibleProvider(settings: {
  apiKey: string;
  baseUrl: string;
  label?: string;
  model?: string;
}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(settings.apiKey, settings.baseUrl, settings.label ?? "OpenAI-compatible", settings.model);
}
