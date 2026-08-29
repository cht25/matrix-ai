// =============================================================================
// Groq provider (spec §15: AIProvider abstraction). The Groq API key NEVER
// leaves the server. Additional providers can be added behind this interface.
//
// Model IDs must stay current — Groq retires production models. As of
// 2026-08-16 llama-3.3-70b-versatile / llama-3.1-8b-instant / the Llama 3.2
// vision previews are shut down for free/developer tiers. Chat uses the
// official replacements (openai/gpt-oss-*); vision uses Qwen 3.6 (multimodal).
// =============================================================================

import { AIProviderError, providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { assistantContentOnly, assistantDeltaContent, createReasoningStreamFilter } from "@/lib/ai/reasoning";

export type AIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AIProviderRequest = {
  model: string;
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
  imageDataUrl?: string; // for vision-capable models
  signal?: AbortSignal;
  requestId?: string;
};

export type AIProviderResponse = {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
};

export interface AIProvider {
  chat(req: AIProviderRequest): Promise<AIProviderResponse>;
  /** Optional streaming support — yields text deltas as they arrive. */
  streamChat?(req: AIProviderRequest): AsyncGenerator<string>;
  /** Real reachability check against the upstream API (never cached, never faked). */
  healthCheck(): Promise<boolean>;
}

function isReasoningModel(model: string): boolean {
  return model.includes("gpt-oss") || model.includes("qwen");
}

export class GroqProvider implements AIProvider {
  private apiKey: string;
  private baseUrl = "https://api.groq.com/openai/v1";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private buildBody(req: AIProviderRequest, stream: boolean): Record<string, unknown> {
    const maxTokens = Math.min(req.maxTokens ?? 1024, 8192);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.5,
      max_tokens: maxTokens,
      stream,
    };
    // Reasoning models (GPT-OSS, Qwen 3.6) require max_completion_tokens and
    // ignore / reject a lone max_tokens. Hide chain-of-thought so the teen
    // only sees the actual answer; keep effort low so first tokens arrive fast.
    if (isReasoningModel(req.model)) {
      body.max_completion_tokens = maxTokens;
      body.reasoning_format = "hidden";
      body.reasoning_effort = req.imageDataUrl || req.model.includes("qwen") ? "none" : "low";
    }
    if (req.imageDataUrl) {
      const last = req.messages[req.messages.length - 1];
      body.messages = [
        ...req.messages.slice(0, -1),
        {
          role: last.role,
          content: [
            { type: "text", text: last.content },
            { type: "image_url", image_url: { url: req.imageDataUrl } },
          ],
        },
      ];
    }
    return body;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildBody(req, false)),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw providerErrorFromException("Groq", req.model, error, req.requestId);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw providerErrorFromResponse("Groq", req.model, res, detail, req.requestId);
    }

    let data: {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (error) {
      throw providerErrorFromException("Groq", req.model, error, req.requestId);
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
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildBody(req, true)),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        if (!res.ok) throw providerErrorFromResponse("Groq", req.model, res, detail, req.requestId);
        throw new Error("Groq returned an empty stream");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      // Reasoning deltas (Groq sends them as `delta.reasoning_content`) are
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
            const json = JSON.parse(payload) as {
              error?: { message?: string; type?: string };
              choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
            };
            if (json.error) {
              throw new AIProviderError({
                provider: "Groq",
                model: req.model,
                type: "provider_unavailable",
                detail: json.error.message ?? "Groq stream error",
                requestId: req.requestId,
              });
            }
            // Drop reasoning deltas (Groq sends them as `delta.reasoning_content`)
            // so only the real answer reaches the user.
            const visible = reasoningFilter.push(assistantDeltaContent(json.choices?.[0]?.delta));
            if (visible) yield visible;
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }
      if (!sawDone) {
        throw new AIProviderError({
          provider: "Groq",
          model: req.model,
          type: "provider_unavailable",
          detail: "provider stream ended before [DONE]",
          requestId: req.requestId,
        });
      }
    } catch (error) {
      throw providerErrorFromException("Groq", req.model, error, req.requestId);
    }
  }
}

// Model registry (server-side only). Official Groq replacements as of 2026-08-16.
export const MODELS = {
  chat: "openai/gpt-oss-120b",
  vision: "qwen/qwen3.6-27b",
  fast: "openai/gpt-oss-20b",
} as const;

export function createProvider(): AIProvider | null {
  const key = process.env.GROQ_API_KEY;
  if (!key || key.endsWith("...")) return null;
  return new GroqProvider(key);
}
