// =============================================================================
// OpenRouter provider — used for coding and Agent mode.
//
// The API key is server-only. OpenRouter exposes an OpenAI-compatible API, but
// lives behind its own provider so general chat can keep using Groq while code
// requests are routed to NVIDIA Nemotron 3 Ultra / Qwen Coder automatically.
// =============================================================================

import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/lib/ai/groq";
import { AIProviderError, providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { assistantContentOnly, assistantDeltaContent, createReasoningStreamFilter } from "@/lib/ai/reasoning";

// The :free variant is intentional. A paid/custom model can still be selected
// explicitly with OPENROUTER_CODING_MODEL; it is never silently rewritten.
export const OPENROUTER_MODELS = {
  coding: process.env.OPENROUTER_CODING_MODEL?.trim() || "nvidia/nemotron-3-ultra-550b-a55b:free",
} as const;

export const CODING_MODEL_LABEL = "NVIDIA Nemotron 3 Ultra";

export class OpenRouterProvider implements AIProvider {
  private readonly baseUrl = "https://openrouter.ai/api/v1";

  constructor(
    private readonly apiKey: string,
    private readonly appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://matrix-ai.app",
  ) {}

  private headers(requestId?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": this.appUrl,
      "X-OpenRouter-Title": "MATRIX AI",
      ...(requestId ? { "X-Request-ID": requestId } : {}),
    };
  }

  private buildBody(req: AIProviderRequest, stream: boolean): Record<string, unknown> {
    const maxTokens = req.maxTokens ?? 16384;
    return {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.35,
      max_tokens: maxTokens,
      max_completion_tokens: maxTokens,
      stream,
    };
  }

  async healthCheck(): Promise<boolean> {
    // GET /models is PUBLIC on OpenRouter — it answers 200 without any valid
    // key, so it cannot be used as a health signal (it used to report "AI
    // Online" while every chat request failed with 401). /auth/key validates
    // the actual key and reports quota/limits WITHOUT consuming the per-model
    // free-tier request budget the way a probe completion would.
    try {
      const response = await fetch(`${this.baseUrl}/auth/key`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        console.error("[MATRIX] AI provider health check failed", {
          provider: "OpenRouter",
          httpStatus: response.status,
          detail: response.status === 401 ? "API key rejected (401)" : `auth/key probe failed (${response.status})`,
        });
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(req.requestId),
        body: JSON.stringify(this.buildBody(req, false)),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw providerErrorFromException("OpenRouter", req.model, error, req.requestId);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw providerErrorFromResponse("OpenRouter", req.model, response, detail, req.requestId);
    }

    let data: {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw providerErrorFromException("OpenRouter", req.model, error, req.requestId);
    }
    return {
      content: assistantContentOnly(data.choices?.[0]?.message),
      model: data.model ?? req.model,
      finishReason: data.choices?.[0]?.finish_reason,
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
        headers: this.headers(req.requestId),
        body: JSON.stringify(this.buildBody(req, true)),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        if (!response.ok) throw providerErrorFromResponse("OpenRouter", req.model, response, detail, req.requestId);
        throw new Error("OpenRouter returned an empty stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      // Reasoning deltas (OpenRouter sends them as `delta.reasoning`) are
      // dropped via assistantDeltaContent, and inline <think> blocks that span
      // several deltas are removed by the stateful filter — without trimming a
      // single space or newline off the visible text.
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
            const tail = reasoningFilter.flush();
            if (tail) yield tail;
            return;
          }
          try {
            const event = JSON.parse(payload) as {
              error?: { message?: string };
              choices?: { delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }[];
            };
            if (event.error) {
              throw new AIProviderError({
                provider: "OpenRouter",
                model: req.model,
                type: "provider_unavailable",
                detail: event.error.message ?? "OpenRouter stream error",
                requestId: req.requestId,
              });
            }
            // Drop reasoning deltas (OpenRouter sends them as `delta.reasoning`)
            // so only the real answer reaches the user.
            const visible = reasoningFilter.push(assistantDeltaContent(event.choices?.[0]?.delta));
            if (visible) yield visible;
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }
      if (!sawDone) {
        throw new AIProviderError({
          provider: "OpenRouter",
          model: req.model,
          type: "provider_unavailable",
          detail: "provider stream ended before [DONE]",
          requestId: req.requestId,
        });
      }
    } catch (error) {
      throw providerErrorFromException("OpenRouter", req.model, error, req.requestId);
    }
  }
}

export function createCodingProvider(): AIProvider | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key || key.endsWith("...") || key.startsWith("YOUR-") || key.startsWith("replace-with")) return null;
  return new OpenRouterProvider(key);
}
