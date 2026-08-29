// =============================================================================
// Generic OpenAI-compatible provider.
//
// This is the provider the admin configures from the Admin panel: an
// OpenAI-compatible base URL (".../v1" or a full ".../chat/completions"), a
// model ID and an API key. It is used as the primary AI route whenever those
// settings are saved; the old environment-keyed providers (Groq / OpenRouter)
// remain as fallbacks so a missing or invalid admin configuration does not
// take the whole assistant offline.
//
// The API key is server-only and is never returned to the browser.
// =============================================================================

import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/lib/ai/groq";
import { AIProviderError, providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";

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

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : "")
    .join("");
}

function isReasoningModel(model: string): boolean {
  return /o[1-9]|gpt-5|gpt-oss|qwen|deepseek|reasoning/i.test(model);
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly providerName = "OpenAI";
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string,
    private readonly label = "OpenAI-compatible",
    private readonly appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://matrix-ai.app",
  ) {
    this.baseUrl = normalizeCompatibleBaseUrl(baseUrl);
    if (!this.baseUrl) throw new Error("OpenAI-compatible base URL is required");
  }

  private headers(requestId?: string): Record<string, string> {
    const isOpenRouter = /(^|\.)openrouter\.ai$/i.test(new URL(this.baseUrl).hostname);
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...(isOpenRouter ? { "HTTP-Referer": this.appUrl, "X-OpenRouter-Title": "MATRIX AI" } : {}),
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
    return body;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
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
      throw providerErrorFromException("OpenAI", req.model, error, req.requestId);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw providerErrorFromResponse("OpenAI", req.model, response, detail, req.requestId);
    }

    let data: {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw providerErrorFromException("OpenAI", req.model, error, req.requestId);
    }
    return {
      content: textContent(data.choices?.[0]?.message?.content),
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
        if (!response.ok) throw providerErrorFromResponse("OpenAI", req.model, response, detail, req.requestId);
        throw new Error("OpenAI-compatible endpoint returned an empty stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
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
            return;
          }
          try {
            const event = JSON.parse(payload) as {
              error?: { message?: string };
              choices?: { delta?: { content?: unknown } }[];
            };
            if (event.error) {
              throw new AIProviderError({
                provider: "OpenAI",
                model: req.model,
                type: "provider_unavailable",
                detail: event.error.message ?? "OpenAI-compatible stream error",
                requestId: req.requestId,
              });
            }
            const delta = textContent(event.choices?.[0]?.delta?.content);
            if (delta) yield delta;
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
}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(settings.apiKey, settings.baseUrl, settings.label ?? "OpenAI-compatible");
}
