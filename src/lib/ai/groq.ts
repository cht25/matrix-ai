// =============================================================================
// Groq provider (spec §15: AIProvider abstraction). The Groq API key NEVER
// leaves the server. Additional providers can be added behind this interface.
//
// Model IDs must stay current — Groq retires production models. As of
// 2026-08-16 llama-3.3-70b-versatile / llama-3.1-8b-instant / the Llama 3.2
// vision previews are shut down for free/developer tiers. Chat uses the
// official replacements (openai/gpt-oss-*); vision uses Qwen 3.6 (multimodal).
// =============================================================================

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
};

export type AIProviderResponse = {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
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
    const maxTokens = req.maxTokens ?? 1024;
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(req, false)),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Groq error ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content?: string | null } }[];
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content ?? "",
      model: data.model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(req, true)),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Groq error ${res.status}: ${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
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
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string | null } }[];
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Ignore malformed keep-alive lines.
        }
      }
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
