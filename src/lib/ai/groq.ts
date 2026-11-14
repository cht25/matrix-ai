// =============================================================================
// Groq provider (spec §15: AIProvider abstraction). The Groq API key NEVER
// leaves the server. Groq hosts the one MATRIX model, GPT OSS 120B; the model
// ID is defined in src/lib/ai/model.ts and passed in by the caller.
// =============================================================================

import { modelById } from "@/lib/ai/models/registry";
import { fetchModelCatalog, verifyCatalogModel, type CatalogModel } from "@/lib/ai/model-catalog";
import { AIProviderError, providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { listAccounts, markFailure, markInvalid, markOk, markRateLimited, nextAvailability, observeHeaders, parseResetDuration, selectAccount, unavailableReason } from "@/lib/ai/accounts";
import { assistantContentOnly, assistantDeltaContent, createReasoningStreamFilter, hasReasoningDelta } from "@/lib/ai/reasoning";

export type AIProviderToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type AIProviderToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type AIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: AIProviderToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type AIProviderRequest = {
  model: string;
  messages: AIMessage[];
  tools?: AIProviderToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  imageDataUrl?: string; // for vision-capable models
  signal?: AbortSignal;
  requestId?: string;
  /** Provider-reported usage for streaming, when the upstream sends it. */
  onUsage?: (usage: AIProviderResponse["usage"]) => void;
  /** Signals real model reasoning activity without exposing raw chain-of-thought. */
  onReasoningActivity?: (phase: "start" | "delta" | "done") => void;
  /** Ask for a JSON object. Honoured only by models that support structured output. */
  jsonMode?: boolean;
};

export type AIProviderResponse = {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
  toolCalls?: AIProviderToolCall[];
};

export interface AIProvider {
  /** True only when this configured endpoint has a tool-call-capable adapter. */
  readonly supportsToolCalls?: boolean;
  chat(req: AIProviderRequest): Promise<AIProviderResponse>;
  /** Optional streaming support — yields text deltas as they arrive. */
  streamChat?(req: AIProviderRequest): AsyncGenerator<string>;
  /** Real reachability check against the upstream API (never cached, never faked). */
  healthCheck(model?: string): Promise<boolean>;
  listModels?(): Promise<CatalogModel[]>;
}

export class GroqProvider implements AIProvider {
  readonly supportsToolCalls = true;
  private apiKey: string;
  private baseUrl = "https://api.groq.com/openai/v1";
  /** When true, each request picks a connected account and rotates on a provider limit. */
  private pooled: boolean;

  constructor(apiKey: string, options: { pooled?: boolean } = {}) {
    this.apiKey = apiKey;
    this.pooled = options.pooled === true;
  }

  /**
   * Send one chat-completions request.
   *
   * With a single fixed key this is one HTTP call. With connected accounts the
   * request goes to the account with the most headroom; when the provider
   * answers that the account is rate-limited, rejected or failing, the same
   * request is sent once to each remaining eligible account. Nothing is lost
   * in between: the request body is rebuilt from the same input every time.
   */
  private async send(req: AIProviderRequest, stream: boolean): Promise<Response> {
    const body = JSON.stringify(this.buildBody(req, stream));
    const post = (key: string) => fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: req.signal ?? AbortSignal.timeout(60_000),
    });
    if (!this.pooled || !listAccounts().length) {
      let res: Response;
      try { res = await post(this.apiKey); }
      catch (error) { throw providerErrorFromException("Groq", req.model, error, req.requestId); }
      if (!res.ok) throw providerErrorFromResponse("Groq", req.model, res, await res.text().catch(() => ""), req.requestId);
      return res;
    }
    const estimate = Math.ceil(body.length / 4) + Math.min(req.maxTokens ?? 1024, 8192);
    const tried = new Set<string>();
    let lastError: AIProviderError | null = null;
    let nextAt: number | null = null;
    for (let turn = 0; turn < 8; turn += 1) {
      if (req.signal?.aborted) break;
      const choice = selectAccount(req.model, estimate, tried);
      if (!choice.account) {
        nextAt = choice.nextAvailableAt;
        break;
      }
      const account = choice.account;
      tried.add(account.id);
      let res: Response;
      try {
        res = await post(account.key);
      } catch (error) {
        if (req.signal?.aborted) throw providerErrorFromException("Groq", req.model, error, req.requestId);
        lastError = providerErrorFromException("Groq", req.model, error, req.requestId);
        markFailure(account.id, req.model, lastError.detail);
        continue;
      }
      observeHeaders(account.id, req.model, res.headers);
      if (res.ok) {
        markOk(account.id, req.model, estimate);
        return res;
      }
      const detail = await res.text().catch(() => "");
      const error = providerErrorFromResponse("Groq", req.model, res, detail, req.requestId);
      lastError = error;
      if (res.status === 429 || res.status === 413) {
        // Groq states the wait in `retry-after` and repeats it in the message.
        const retryAfter = parseResetDuration(res.headers?.get?.("retry-after")) ?? parseResetDuration(/try again in ([0-9hms.]+)/i.exec(detail)?.[1]?.replace(/\.$/, ""));
        markRateLimited(account.id, req.model, retryAfter, error.detail);
        continue;
      }
      if ((res.status === 401 || res.status === 403) && !error.modelUnavailable) {
        markInvalid(account.id, error.detail);
        continue;
      }
      if (res.status >= 500) {
        markFailure(account.id, req.model, error.detail);
        continue;
      }
      // The request itself was refused (bad input, unknown model): another
      // account would answer the same way.
      throw error;
    }
    const retryAt = nextAt ?? nextAvailability(req.model, estimate);
    if (lastError) {
      throw new AIProviderError({
        provider: "Groq", model: req.model, status: lastError.status, type: lastError.type, detail: tried.size > 1 ? `${lastError.detail} (all ${tried.size} connected accounts tried)` : lastError.detail,
        requestId: lastError.requestId, code: lastError.code, modelUnavailable: lastError.modelUnavailable, retryAt,
      });
    }
    const reason = unavailableReason(req.model);
    const wait = retryAt ? ` Next attempt possible in ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))}s.` : "";
    throw new AIProviderError({
      provider: "Groq", model: req.model, status: reason === "rate_limit" ? 429 : reason === "authentication" ? 401 : 503, type: reason, requestId: req.requestId, retryAt,
      detail: (reason === "rate_limit" ? "every connected account is at its provider limit for this model." : reason === "authentication" ? "every connected account's key was rejected by the provider." : "the provider is failing on every connected account.") + wait,
    });
  }

  private buildBody(req: AIProviderRequest, stream: boolean): Record<string, unknown> {
    if (!req.model) throw new Error("GROQ_MODEL_NOT_CONFIGURED");
    const maxTokens = Math.min(req.maxTokens ?? 1024, modelById(req.model)?.maxOutputTokens ?? 8192, 8192);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.5,
      max_tokens: maxTokens,
      stream,
    };
    // Reasoning models require max_completion_tokens and
    // ignore / reject a lone max_tokens. Hide chain-of-thought so the teen
    // only sees the actual answer; keep effort low so first tokens arrive fast.
    const spec = modelById(req.model);
    if (spec?.reasoning === "effort") {
      body.max_completion_tokens = maxTokens;
      body.reasoning_format = "hidden";
      body.reasoning_effort = "low";
    } else if (spec?.reasoning === "format") {
      // Thinking models that take no effort level: only hide the scratchpad.
      body.max_completion_tokens = maxTokens;
      body.reasoning_format = "hidden";
    }
    // Structured output is only requested from models that support it.
    if (req.jsonMode && spec?.structuredOutput && !stream) body.response_format = { type: "json_object" };
    if (req.tools?.length && !stream) {
      body.tools = req.tools;
      body.tool_choice = "auto";
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

  async listModels(): Promise<CatalogModel[]> {
    return (await fetchModelCatalog({ baseUrl: this.baseUrl, apiKey: this.apiKey, provider: "Groq" })).models;
  }

  async verifyModel(model: string): Promise<void> { await verifyCatalogModel({ baseUrl: this.baseUrl, apiKey: this.apiKey, provider: "Groq" }, model); }

  async healthCheck(): Promise<boolean> {
    // Groq's /models requires a valid Bearer key (401 otherwise), so unlike a
    // public model list this is an honest key+reachability probe that does not
    // consume per-model chat quota. Never "simplify" this to an unauthenticated
    // endpoint — that is how the health indicator ends up lying.
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.error("[MATRIX] AI provider health check failed", {
          provider: "Groq",
          httpStatus: res.status,
          detail: res.status === 401 ? "API key rejected (401)" : `/models probe failed (${res.status})`,
        });
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    const res = await this.send(req, false);

    let data: {
      choices?: { message?: { content?: string | null; tool_calls?: AIProviderToolCall[] }; finish_reason?: string }[];
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
      toolCalls: (data.choices?.[0]?.message?.tool_calls ?? []).slice(0, 20).filter((call) =>
        typeof call?.id === "string" && typeof call?.function?.name === "string" && typeof call?.function?.arguments === "string"),
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
      res = await this.send(req, true);
      if (!res.body) throw new Error("Groq returned an empty stream");

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
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            if (json.usage) {
              const promptTokens = json.usage.prompt_tokens ?? 0;
              const completionTokens = json.usage.completion_tokens ?? 0;
              req.onUsage?.({ promptTokens, completionTokens, totalTokens: json.usage.total_tokens ?? promptTokens + completionTokens });
            }
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
            // so only the real answer reaches the user, while signaling live activity.
            const deltaObj = json.choices?.[0]?.delta;
            if (hasReasoningDelta(deltaObj)) {
              req.onReasoningActivity?.("delta");
            }
            const visible = reasoningFilter.push(assistantDeltaContent(deltaObj));
            if (visible) {
              req.onReasoningActivity?.("done");
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

export function createProvider(): AIProvider | null {
  const key = (process.env.GROQ_API_KEY || process.env.GPT_OSS_API_KEY)?.trim();
  if (!key || key.endsWith("...") || key.startsWith("YOUR-") || key.startsWith("replace-with")) return null;
  return new GroqProvider(key);
}
