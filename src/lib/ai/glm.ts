// =============================================================================
// GLM (Zhipu AI / Z.ai) Primary High-End & Coding Provider.
//
// GLM is MATRIX AI's primary engine for coding, web development, Agent/build
// orchestration, multimodal vision, and complex/high-load reasoning tasks,
// with no implicit provider substitution when credentials are absent.
//
// Uses GLM's native OpenAI-compatible v4 protocol (`/api/paas/v4/chat/completions`)
// with server-side secret isolation, native tool calling, multimodal image_url
// support, and private chain-of-thought (`reasoning_content` / `<think>`) filtering.
// =============================================================================

import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  AIProviderToolCall,
} from "@/lib/ai/groq";
import { AIProviderError, providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { assistantContentOnly, assistantDeltaContent, createReasoningStreamFilter, hasReasoningDelta } from "@/lib/ai/reasoning";
import { fetchModelCatalog, type CatalogModel } from "@/lib/ai/model-catalog";
import { cachedRealHealthCheck, healthCacheKey } from "@/lib/ai/provider-health";
import { normalizeCompatibleBaseUrl } from "@/lib/ai/openai";

export const GLM_API_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const GLM_INTL_API_BASE_URL = "https://api.z.ai/api/paas/v4";

export const GLM_DEFAULT_MODEL = "glm-5-turbo";
export const GLM_DEFAULT_CODING_MODEL = GLM_DEFAULT_MODEL;
export const GLM_DEFAULT_VISION_MODEL = "glm-4.6v";

export const GLM_KNOWN_MODELS: ReadonlyArray<CatalogModel> = [
  { id: "glm-5-turbo", label: "GLM-5-Turbo (Default Chat & Agent)" },
  { id: "glm-4.7", label: "GLM-4.7 (Flagship Coding & High-Load)" },
  { id: "glm-4.6", label: "GLM-4.6 (High-End Reasoning & Web Dev)" },
  { id: "glm-4.6v", label: "GLM-4.6V (Multimodal Vision)" },
  { id: "glm-4.5", label: "GLM-4.5 (Balanced Coding & Chat)" },
  { id: "glm-4.5-air", label: "GLM-4.5 Air (Fast Efficient)" },
  { id: "glm-4-plus", label: "GLM-4 Plus" },
  { id: "glm-4v-plus", label: "GLM-4V Plus (Vision)" },
];

export function resolveGlmBaseUrl(explicit?: string): string {
  const candidate = (explicit || process.env.GLM_BASE_URL || "").trim();
  // A Z.ai international key must not silently go to the mainland gateway.
  const defaultBase = process.env.ZAI_API_KEY?.trim() ? GLM_INTL_API_BASE_URL : GLM_API_BASE_URL;
  return normalizeCompatibleBaseUrl(candidate || defaultBase) || defaultBase;
}

function parseToolCalls(value: unknown): AIProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const call = entry as Record<string, unknown>;
    const fn = call.function && typeof call.function === "object" ? (call.function as Record<string, unknown>) : null;
    if (typeof call.id !== "string" || !call.id.trim() || typeof fn?.name !== "string" || typeof fn.arguments !== "string") return [];
    return [{
      id: call.id.slice(0, 128),
      type: "function" as const,
      function: { name: fn.name.slice(0, 64), arguments: fn.arguments.slice(0, 12_000) },
    }];
  });
}

export class GLMProvider implements AIProvider {
  readonly providerName = "GLM";
  readonly supportsToolCalls = true;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl?: string,
    private readonly healthCheckModel = GLM_DEFAULT_MODEL,
  ) {
    if (!apiKey.trim()) throw new Error("GLM_API_KEY_REQUIRED");
    this.baseUrl = resolveGlmBaseUrl(baseUrl);
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
    const maxTokens = req.maxTokens ?? 4096;
    const body: Record<string, unknown> = {
      model: req.model || GLM_DEFAULT_MODEL,
      messages: this.buildMessages(req),
      temperature: req.temperature ?? 0.4,
      max_tokens: maxTokens,
      stream,
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }
    return body;
  }

  async listModels(): Promise<CatalogModel[]> {
    try {
      const live = await fetchModelCatalog({ baseUrl: this.baseUrl, apiKey: this.apiKey });
      if (live.models.length > 0) {
        const ids = new Set(live.models.map((m) => m.id));
        const merged = [...live.models];
        for (const known of GLM_KNOWN_MODELS) {
          if (!ids.has(known.id)) merged.push(known);
        }
        return merged;
      }
    } catch (error) {
      if (error instanceof AIProviderError && error.type === "authentication") {
        throw error;
      }
      // Regional GLM PaaS endpoints may omit GET /models while serving
      // POST /chat/completions; return the verified official GLM catalog.
    }
    return [...GLM_KNOWN_MODELS];
  }

  async healthCheck(explicitModel?: string): Promise<boolean> {
    const model = explicitModel || this.healthCheckModel || GLM_DEFAULT_MODEL;
    const probe = async () => {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          redirect: "error",
          headers: this.headers(),
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return { ok: true, status: response.status, detail: "ok" };
        const detail = await response.text().catch(() => "");
        return { ok: false, status: response.status, detail };
      } catch (error) {
        return { ok: false, status: null, detail: error instanceof Error ? error.message : "network error" };
      }
    };
    const result = await cachedRealHealthCheck(
      healthCacheKey(["glm", this.baseUrl, model, this.apiKey.slice(-4)]),
      probe,
    );
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
        signal: req.signal ?? AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw providerErrorFromException("GLM", req.model, error, req.requestId);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw providerErrorFromResponse("GLM", req.model, response, detail, req.requestId);
    }

    let data: {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: AIProviderToolCall[] }; finish_reason?: string }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw providerErrorFromException("GLM", req.model, error, req.requestId);
    }
    const msg = data.choices?.[0]?.message;
    if (msg && typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
      req.onReasoningActivity?.("done");
    }
    return {
      content: assistantContentOnly(msg),
      model: data.model ?? req.model,
      finishReason: data.choices?.[0]?.finish_reason,
      toolCalls: parseToolCalls(msg?.tool_calls),
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
        signal: req.signal ?? AbortSignal.timeout(90_000),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        if (!response.ok) throw providerErrorFromResponse("GLM", req.model, response, detail, req.requestId);
        throw new Error("GLM endpoint returned an empty stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
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
                provider: "GLM",
                model: req.model,
                type: "provider_unavailable",
                detail: event.error.message ?? "GLM stream error",
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
        const tail = reasoningFilter.flush();
        if (tail) yield tail;
      }
    } catch (error) {
      throw providerErrorFromException("GLM", req.model, error, req.requestId);
    }
  }
}

export function createGlmProvider(): AIProvider | null {
  const key = process.env.GLM_API_KEY?.trim() ?? "";
  if (!key || key.endsWith("...") || key.startsWith("YOUR-") || key.startsWith("replace-with")) return null;
  return new GLMProvider(key);
}
