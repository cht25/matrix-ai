// =============================================================================
// Cloudflare Workers AI provider (server-side).
//
// Official REST API:
//   POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL_ID}
//   Authorization: Bearer {CLOUDFLARE_API_TOKEN}
//   docs: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
//
// The API token NEVER leaves this server: it is read from the backend
// environment only (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) and is
// never echoed to the browser, never written to logs (every detail string
// passes sanitizeProviderDetail) and never overridable per request.
//
// Response shapes are handled defensively because Workers AI serves several
// model families through the same endpoint:
//   • OpenAI-compatible: { result: { choices: [...], usage: {...} } }
//   • native:            { result: { response: "..." } }
// Streaming accepts both chunk styles and an optional `data: [DONE]`.
//
// Free-plan quota (10,000 Neurons/day) is enforced BEFORE a request leaves
// the server (src/lib/ai/cloudflare-quota.ts) and recognised in provider
// errors, so the gateway can fall back to the existing providers instead of
// burning a request against an exhausted account.
// =============================================================================

import "server-only";

import { CLOUDFLARE_MODEL_ID, modelById } from "@/lib/ai/models/registry";
import {
  AIProviderError,
  providerErrorFromException,
  providerErrorFromResponse,
  sanitizeProviderDetail,
} from "@/lib/ai/provider-error";
import type {
  AIMessage,
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  AIProviderToolCall,
  AIProviderToolDefinition,
} from "@/lib/ai/groq";
import type { CatalogModel } from "@/lib/ai/model-catalog";
import {
  assertCloudflareQuota,
  cloudflareQuotaConfig,
  markCloudflareQuotaExhausted,
  msUntilUtcMidnight,
  recordCloudflareRequest,
} from "@/lib/ai/cloudflare-quota";

export type CloudflareCredentials = {
  accountId: string;
  apiToken: string;
  /** The model id to run when the request does not name one. */
  model: string;
};

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Values that mean "not configured yet" (mirrors .env.example placeholders). */
function usable(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("...") || trimmed.includes("YOUR-") || trimmed.startsWith("replace-with")) return "";
  return trimmed;
}

/**
 * Server-side Cloudflare configuration, or null when it is not installed.
 * `CLOUDFLARE_DEFAULT_MODEL` defaults to the registry's Cloudflare model so a
 * deployment only needs the account id + token to go live.
 */
export function cloudflareCredentials(env: Record<string, string | undefined> = process.env): CloudflareCredentials | null {
  const accountId = usable(env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = usable(env.CLOUDFLARE_API_TOKEN);
  if (!accountId || !apiToken) return null;
  const configuredModel = usable(env.CLOUDFLARE_DEFAULT_MODEL);
  return { accountId, apiToken, model: configuredModel || CLOUDFLARE_MODEL_ID };
}

export function cloudflareConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return cloudflareCredentials(env) !== null;
}

/** Never the token itself — safe for diagnostics. */
export function redactedConfig(credentials: CloudflareCredentials): Record<string, string> {
  return {
    account_id: `${credentials.accountId.slice(0, 4)}…${credentials.accountId.slice(-4)}`,
    model: credentials.model,
  };
}

function runUrl(credentials: CloudflareCredentials, model: string): string {
  // Model ids contain slashes on purpose (`@cf/zai-org/glm-4.7-flash`) and are
  // path segments of the endpoint — only query/fragment delimiters are
  // stripped so a hostile model string cannot alter the request.
  const safeModel = model.replace(/[#?]/g, "").replace(/\.\./g, "");
  return `${API_BASE}/accounts/${encodeURIComponent(credentials.accountId)}/ai/run/${safeModel}`;
}

type CloudflareErrorBody = { message: string; code?: string };

/** Cloudflare's error envelope is `{ errors: [{ code, message }] }`. */
function parseCloudflareError(body: string): CloudflareErrorBody {
  if (!body) return { message: "empty provider error response" };
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ code?: unknown; message?: unknown }>;
      error?: { message?: unknown; code?: unknown } | string;
      message?: unknown;
    };
    const first = Array.isArray(parsed.errors) ? parsed.errors[0] : undefined;
    if (first && typeof first.message === "string") {
      return { message: first.message, code: typeof first.code === "string" ? first.code : first.code != null ? String(first.code) : undefined };
    }
    if (typeof parsed.error === "string") return { message: parsed.error };
    if (parsed.error && typeof parsed.error === "object") {
      return {
        message: typeof parsed.error.message === "string" ? parsed.error.message : "provider rejected the request",
        code: typeof parsed.error.code === "string" ? parsed.error.code : undefined,
      };
    }
    if (typeof parsed.message === "string") return { message: parsed.message };
  } catch {
    /* not JSON — fall through to the raw (sanitised) body */
  }
  return { message: body };
}

/** Free-quota exhaustion: Cloudflare reports it as a neuron/usage limit. */
export function isCloudflareQuotaExhausted(status: number, body: string): boolean {
  const text = body.toLowerCase();
  if (!/(neuron|quota|usage limit|daily limit|limit exceeded|resource limit|exceeded your)/.test(text)) return false;
  // Missing-permission messages can mention "usage" too; those are auth errors.
  if (/(permission|scope|authoriz|not authorized|authentication)/.test(text) && !/neuron/.test(text)) return false;
  return status === 402 || status === 403 || status === 429 || status === 400;
}

function quotaError(model: string, status: number, detail: string, requestId?: string): AIProviderError {
  // Stop sending into the exhausted account for the rest of the UTC day.
  markCloudflareQuotaExhausted();
  return new AIProviderError({
    provider: "Cloudflare",
    model,
    status,
    type: "rate_limit",
    code: "CLOUDFLARE_QUOTA_EXHAUSTED",
    detail: sanitizeProviderDetail(
      detail ||
        "Cloudflare Workers AI free quota for today is exhausted (resets 00:00 UTC). No further requests were sent.",
    ),
    requestId,
    retryAt: Date.now() + msUntilUtcMidnight(),
  });
}

type UsageLike = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; neurons?: number; units?: number };

/** Neuron usage only when the response itself reports it — never estimated. */
function reportedNeurons(payload: Record<string, unknown> | undefined): number | null {
  if (!payload) return null;
  const usage = (payload.usage ?? payload) as UsageLike;
  const value = typeof usage.neurons === "number" ? usage.neurons : typeof usage.units === "number" ? usage.units : null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(payload: Record<string, unknown> | undefined): AIProviderResponse["usage"] {
  const usage = (payload?.usage ?? {}) as UsageLike;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: usage.total_tokens ?? promptTokens + completionTokens };
}

export class CloudflareProvider implements AIProvider {
  readonly supportsToolCalls = true;
  private readonly credentials: CloudflareCredentials;

  constructor(credentials: CloudflareCredentials) {
    this.credentials = credentials;
  }

  private async send(req: AIProviderRequest, stream: boolean): Promise<Response> {
    // Quota gate: an exhausted free day is detected BEFORE the request leaves
    // the server, so the gateway falls back instead of burning a call.
    await assertCloudflareQuota(req.model || this.credentials.model);

    const body = JSON.stringify(this.buildBody(req, stream));
    let res: Response;
    try {
      res = await fetch(runUrl(this.credentials, req.model || this.credentials.model), {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials.apiToken}`,
        },
        body,
        signal: req.signal ?? AbortSignal.timeout(stream ? 180_000 : 120_000),
      });
    } catch (error) {
      if (req.signal?.aborted) throw error;
      throw providerErrorFromException("Cloudflare", req.model, error, req.requestId);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      void recordCloudflareRequest({ model: req.model || this.credentials.model, ok: false, status: res.status }).catch(() => {});
      if (isCloudflareQuotaExhausted(res.status, detail)) {
        throw quotaError(req.model, res.status, parseCloudflareError(detail).message, req.requestId);
      }
      // Normalise Cloudflare's error envelope into the generic provider
      // error parser so status→type mapping and sanitisation stay shared.
      const parsed = parseCloudflareError(detail);
      const synthetic = JSON.stringify({ error: { message: parsed.message, ...(parsed.code ? { code: parsed.code } : {}) } });
      const error = providerErrorFromResponse("Cloudflare", req.model, res, synthetic, req.requestId);
      // A missing/invalid ACCOUNT id is not "this model is unavailable".
      if (res.status === 404 && /account/i.test(parsed.message)) {
        throw new AIProviderError({
          provider: "Cloudflare",
          model: req.model,
          status: 404,
          type: "invalid_request",
          code: "INVALID_ACCOUNT_ID",
          detail: `Cloudflare account id is invalid or not accessible: ${parsed.message}`,
          requestId: req.requestId,
        });
      }
      throw error;
    }
    return res;
  }

  private buildBody(req: AIProviderRequest, stream: boolean): Record<string, unknown> {
    const model = req.model || this.credentials.model;
    const spec = modelById(model);
    const maxTokens = Math.min(req.maxTokens ?? 1024, spec?.maxOutputTokens ?? 8_192, 16_384);
    const body: Record<string, unknown> = {
      messages: req.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      })),
      stream,
      max_tokens: maxTokens,
      temperature: req.temperature ?? 0.5,
    };
    // Structured output is only requested from models that support it.
    if (req.jsonMode && spec?.structuredOutput && !stream) body.response_format = { type: "json_object" };
    // Tool calling mirrors the Groq adapter: tools travel with the
    // non-streaming request the Agent executor uses.
    if (req.tools?.length && !stream) {
      body.tools = req.tools as AIProviderToolDefinition[];
      body.tool_choice = "auto";
    }
    if (req.imageDataUrl) {
      const last = req.messages[req.messages.length - 1];
      body.messages = [
        ...req.messages.slice(0, -1),
        { role: last.role, content: [{ type: "text", text: last.content }, { type: "image_url", image_url: { url: req.imageDataUrl } }] },
      ];
    }
    return body;
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    const model = req.model || this.credentials.model;
    const res = await this.send(req, false);
    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch (error) {
      throw providerErrorFromException("Cloudflare", model, error, req.requestId);
    }
    // Cloudflare wraps the model output in `result`; tolerate both shapes.
    const payload = (data.result ?? data) as Record<string, unknown>;
    const choices = Array.isArray(payload.choices) ? (payload.choices as Array<Record<string, unknown>>) : [];
    const message = (choices[0]?.message ?? {}) as { content?: unknown; tool_calls?: unknown };
    const nativeToolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
    const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : nativeToolCalls;
    const toolCalls = (rawToolCalls as AIProviderToolCall[])
      .slice(0, 20)
      .filter((call) => typeof call?.id === "string" && typeof call?.function?.name === "string" && typeof call?.function?.arguments === "string");
    const content =
      typeof message.content === "string"
        ? message.content
        : typeof payload.response === "string"
          ? (payload.response as string)
          : "";
    const finishReason = typeof choices[0]?.finish_reason === "string" ? (choices[0].finish_reason as string) : undefined;

    void recordCloudflareRequest({ model, ok: true, neurons: reportedNeurons(payload) }).catch(() => {});
    req.onUsage?.(usageOf(payload));
    if (toolCalls.length) req.onReasoningActivity?.("done");
    return { content, model, usage: usageOf(payload), finishReason, toolCalls };
  }

  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    const model = req.model || this.credentials.model;
    let res: Response;
    try {
      res = await this.send(req, true);
      if (!res.body) throw new AIProviderError({ provider: "Cloudflare", model, type: "provider_unavailable", detail: "Cloudflare returned an empty stream", requestId: req.requestId });
    } catch (error) {
      if (req.signal?.aborted || error instanceof AIProviderError) throw error;
      throw providerErrorFromException("Cloudflare", model, error, req.requestId);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    let recorded = false;
    const finishUsage = () => {
      if (recorded) return;
      recorded = true;
      void recordCloudflareRequest({ model, ok: true, neurons: null }).catch(() => {});
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payloadText = trimmed.slice(5).trim();
          if (payloadText === "[DONE]") {
            sawDone = true;
            finishUsage();
            return;
          }
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(payloadText) as Record<string, unknown>;
          } catch {
            continue; // keep-alive comments / partial frames
          }
          if (json.error) {
            const errorBody = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
            if (isCloudflareQuotaExhausted(429, errorBody)) throw quotaError(model, 429, parseCloudflareError(errorBody).message, req.requestId);
            throw new AIProviderError({
              provider: "Cloudflare",
              model,
              type: "provider_unavailable",
              detail: sanitizeProviderDetail(errorBody),
              requestId: req.requestId,
            });
          }
          const usage = (json.usage ?? (json.result as Record<string, unknown> | undefined)?.usage) as UsageLike | undefined;
          if (usage && typeof usage.prompt_tokens === "number") {
            req.onUsage?.({
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
            });
          }
          const result = (json.result ?? json) as Record<string, unknown>;
          const choices = Array.isArray(result.choices) ? (result.choices as Array<Record<string, unknown>>) : [];
          const delta = (choices[0]?.delta ?? {}) as { content?: unknown };
          let piece = "";
          if (typeof delta.content === "string") piece = delta.content;
          else if (typeof result.response === "string") piece = result.response as string;
          if (piece) {
            req.onReasoningActivity?.("done");
            yield piece;
          }
        }
      }
      // A stream that ended without [DONE] is still a complete answer for
      // Cloudflare's native chunking; the executor reports empty output.
      finishUsage();
      if (!sawDone) return;
    } catch (error) {
      if (req.signal?.aborted) throw error;
      throw providerErrorFromException("Cloudflare", model, error, req.requestId);
    }
  }

  /**
   * Honest reachability probe: the model list endpoint needs a valid token
   * AND account access, so a 200 proves credentials work without spending
   * inference quota. Cached briefly by the shared health cache at the caller.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/accounts/${encodeURIComponent(this.credentials.accountId)}/ai/models/search?per_page=1`, {
        headers: { Authorization: `Bearer ${this.credentials.apiToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        console.error("[QORVYNA] AI provider health check failed", {
          provider: "Cloudflare",
          httpStatus: res.status,
          detail: res.status === 401 || res.status === 403 ? "API token rejected or missing Workers AI permission" : `models probe failed (${res.status})`,
          ...redactedConfig(this.credentials),
        });
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Cloudflare's model catalog for this account (ids only, no credentials). */
  async listModels(): Promise<CatalogModel[]> {
    return listCloudflareModels(this.credentials);
  }
}

/**
 * Model ids this account can actually run, via
 * GET /accounts/{id}/ai/models/search. The caller treats a failure as
 * "could not verify" — it never guesses availability from thin air.
 */
export async function listCloudflareModels(credentials: CloudflareCredentials): Promise<CatalogModel[]> {
  const res = await fetch(`${API_BASE}/accounts/${encodeURIComponent(credentials.accountId)}/ai/models/search?per_page=100`, {
    headers: { Authorization: `Bearer ${credentials.apiToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Cloudflare model list failed (${res.status})`);
  const data = (await res.json().catch(() => ({}))) as { result?: Array<Record<string, unknown>> };
  const results = Array.isArray(data.result) ? data.result : [];
  return results
    .map((entry) => {
      const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : "";
      const label = typeof entry.name === "string" ? entry.name : id;
      return id ? { id, label } : null;
    })
    .filter((model): model is CatalogModel => model !== null);
}
