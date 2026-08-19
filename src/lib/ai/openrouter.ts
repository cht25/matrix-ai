// =============================================================================
// OpenRouter provider — used for coding and Agent mode.
//
// The API key is server-only. OpenRouter exposes an OpenAI-compatible API, but
// lives behind its own provider so general chat can keep using Groq while code
// requests are routed to NVIDIA Nemotron 3 Ultra automatically.
// =============================================================================

import type {
  AIMessage,
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/lib/ai/groq";

export const OPENROUTER_MODELS = {
  coding: process.env.OPENROUTER_CODING_MODEL?.trim() || "nvidia/nemotron-3-ultra-550b-a55b",
} as const;

export const CODING_MODEL_LABEL = "NVIDIA Nemotron 3 Ultra";

export class OpenRouterProvider implements AIProvider {
  private readonly baseUrl = "https://openrouter.ai/api/v1";

  constructor(
    private readonly apiKey: string,
    private readonly appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://matrix-ai.app",
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": this.appUrl,
      "X-Title": "MATRIX AI",
    };
  }

  private buildBody(req: AIProviderRequest, stream: boolean): Record<string, unknown> {
    return {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.35,
      max_completion_tokens: req.maxTokens ?? 4096,
      stream,
      // OpenRouter normalises this for reasoning-capable providers. The model's
      // private reasoning is never shown to the user; only `content` is read.
      reasoning: { effort: "high", exclude: true },
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
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
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req, false)),
      signal: req.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenRouter error ${response.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      model: data.model ?? req.model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req, true)),
      signal: req.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenRouter error ${response.status}: ${detail.slice(0, 300)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
        if (payload === "[DONE]") return;
        try {
          const event = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null } }[];
          };
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Keep-alive or malformed upstream line; skip it.
        }
      }
    }
  }
}

export function createCodingProvider(): AIProvider | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key || key.endsWith("...")) return null;
  return new OpenRouterProvider(key);
}

export type { AIMessage };
