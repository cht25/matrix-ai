// =============================================================================
// Groq provider (spec §15: AIProvider abstraction). The Groq API key NEVER
// leaves the server. Additional providers can be added behind this interface.
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
}

export class GroqProvider implements AIProvider {
  private apiKey: string;
  private baseUrl = "https://api.groq.com/openai/v1";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 1024,
    };
    if (req.imageDataUrl) {
      // Vision: attach the image to the last user message.
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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Groq error ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
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
}

// Model registry (server-side only).
export const MODELS = {
  chat: "llama-3.3-70b-versatile",
  vision: "llama-3.2-11b-vision-preview",
  fast: "llama-3.1-8b-instant",
} as const;

export function createProvider(): AIProvider | null {
  // Deno (edge function) or Node (tests) compatible env access.
  const deno = (globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno;
  const key = deno?.env.get("GROQ_API_KEY");
  if (!key) return null;
  return new GroqProvider(key);
}
