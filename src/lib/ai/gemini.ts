import type { AIProvider, AIProviderRequest, AIProviderResponse, AIMessage, AIProviderToolCall } from "@/lib/ai/groq";
import type { CatalogModel } from "@/lib/ai/model-catalog";
import { AIProviderError, providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";
import { cachedRealHealthCheck, healthCacheKey } from "@/lib/ai/provider-health";

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export function parseGeminiModelCatalog(payload: unknown): CatalogModel[] {
  const models = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const raw = typeof item.name === "string" ? item.name : "";
    const id = raw.replace(/^models\//, "").trim();
    const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
    if (!id || id.length > 220 || /[\x00-\x20]/.test(id) || seen.has(id) || !methods.includes("generateContent")) return [];
    seen.add(id);
    return [{ id, label: typeof item.displayName === "string" ? item.displayName.slice(0, 160) : id, ...(typeof item.version === "string" ? { ownedBy: item.version.slice(0, 100) } : {}) }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function modelPath(model: string, operation: "generateContent" | "streamGenerateContent"): string {
  const id = model.trim().replace(/^models\//, "");
  if (!id || id.length > 220 || /[\x00-\x20/]/.test(id)) throw new Error("GEMINI_MODEL_INVALID");
  return `/models/${encodeURIComponent(id)}:${operation}`;
}

function geminiFunctionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function contentsFor(messages: AIMessage[], imageDataUrl?: string) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "assistant" && message.tool_calls?.length) {
      return { role: "model", parts: message.tool_calls.map((call) => ({ functionCall: { name: geminiFunctionName(call.function.name), args: jsonObject(call.function.arguments) } })) };
    }
    if (message.role === "tool") {
      return { role: "user", parts: [{ functionResponse: { name: geminiFunctionName(message.name ?? "unknown_tool"), response: jsonObject(message.content) } }] };
    }
    return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
  });
  if (imageDataUrl && conversation.length) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(imageDataUrl);
    if (!match) throw new Error("GEMINI_IMAGE_DATA_INVALID");
    conversation[conversation.length - 1].parts.push({ inlineData: { mimeType: match[1], data: match[2] } } as never);
  }
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: conversation,
  };
}

function geminiSchema(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof value.type === "string") out.type = value.type.toUpperCase();
  if (typeof value.description === "string") out.description = value.description;
  if (Array.isArray(value.enum)) out.enum = value.enum;
  if (Array.isArray(value.required)) out.required = value.required;
  if (value.items && typeof value.items === "object") out.items = geminiSchema(value.items as Record<string, unknown>);
  if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
    out.properties = Object.fromEntries(Object.entries(value.properties as Record<string, unknown>).map(([key, child]) => [key, child && typeof child === "object" ? geminiSchema(child as Record<string, unknown>) : {}]));
  }
  return out;
}

function functionDeclarations(req: AIProviderRequest) {
  return req.tools?.length ? [{ functionDeclarations: req.tools.map(({ function: declaration }) => ({
    name: geminiFunctionName(declaration.name),
    description: declaration.description,
    parameters: geminiSchema(declaration.parameters),
  })) }] : undefined;
}

function toolCallsFrom(data: Record<string, unknown>, req: AIProviderRequest): AIProviderToolCall[] {
  const candidate = (Array.isArray(data.candidates) ? data.candidates[0] : undefined) as Record<string, unknown> | undefined;
  const content = candidate?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const names = new Map((req.tools ?? []).map(({ function: declaration }) => [geminiFunctionName(declaration.name), declaration.name]));
  return parts.flatMap((part, index) => {
    const call = part && typeof part === "object" ? (part as Record<string, unknown>).functionCall as Record<string, unknown> | undefined : undefined;
    if (typeof call?.name !== "string") return [];
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
    return [{ id: `gemini-${index}`, type: "function" as const, function: { name: names.get(call.name) ?? call.name, arguments: JSON.stringify(args) } }];
  }).slice(0, 10);
}

function usageFrom(data: Record<string, unknown>) {
  const usage = data.usageMetadata as Record<string, unknown> | undefined;
  const promptTokens = typeof usage?.promptTokenCount === "number" ? usage.promptTokenCount : 0;
  const completionTokens = typeof usage?.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0;
  return { promptTokens, completionTokens, totalTokens: typeof usage?.totalTokenCount === "number" ? usage.totalTokenCount : promptTokens + completionTokens };
}

function textFrom(data: Record<string, unknown>): string {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const content = (candidates[0] as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  return parts.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, string>).text : "").join("");
}

export class GeminiProvider implements AIProvider {
  readonly providerName = "Gemini";
  readonly supportsToolCalls = true;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = GEMINI_API_BASE_URL,
  ) {
    if (!apiKey.trim()) throw new Error("GEMINI_API_KEY_REQUIRED");
  }

  private headers(requestId?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": this.apiKey,
      ...(requestId ? { "X-Request-ID": requestId } : {}),
    };
  }

  async listModels(): Promise<CatalogModel[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
    } catch (error) {
      throw providerErrorFromException("Gemini", "catalog", error);
    }
    if (!response.ok) throw providerErrorFromResponse("Gemini", "catalog", response, await response.text().catch(() => ""));
    let payload: unknown;
    try { payload = await response.json(); } catch (error) { throw providerErrorFromException("Gemini", "catalog", error); }
    const models = parseGeminiModelCatalog(payload);
    if (!models.length) throw new AIProviderError({ provider: "Gemini", model: "catalog", type: "invalid_request", detail: "Gemini returned no models supporting generateContent." });
    return models;
  }

  async healthCheck(model?: string): Promise<boolean> {
    // Probe the exact configured/selected model rather than treating an API
    // key or a non-empty catalog as proof that generation works. This makes a
    // real one-token provider call; provider quota/billing is determined by
    // Google and is never represented as free or guaranteed.
    if (!model?.trim()) return false;
    const selected = model.trim();
    const result = await cachedRealHealthCheck(healthCacheKey(["gemini", this.baseUrl, selected, this.apiKey.slice(-4)]), async () => {
      try {
        const models = await this.listModels();
        if (!models.some((entry) => entry.id === selected)) return { ok: false, status: 404, detail: "selected model is absent from the Gemini catalog" };
        await this.chat({ model: selected, messages: [{ role: "user", content: "Reply with one character." }], maxTokens: 1 });
        return { ok: true, status: 200, detail: "ok" };
      } catch (error) {
        return { ok: false, status: error instanceof AIProviderError ? error.status : null, detail: error instanceof Error ? error.message : "Gemini health probe failed" };
      }
    });
    return result.ok;
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${modelPath(req.model, "generateContent")}`, {
        method: "POST",
        headers: this.headers(req.requestId),
        body: JSON.stringify({
          ...contentsFor(req.messages, req.imageDataUrl),
          ...(functionDeclarations(req) ? { tools: functionDeclarations(req) } : {}),
          generationConfig: {
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
          },
        }),
        redirect: "error",
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) { throw providerErrorFromException("Gemini", req.model, error, req.requestId); }
    if (!response.ok) throw providerErrorFromResponse("Gemini", req.model, response, await response.text().catch(() => ""), req.requestId);
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; } catch (error) { throw providerErrorFromException("Gemini", req.model, error, req.requestId); }
    const content = textFrom(data);
    const toolCalls = toolCallsFrom(data, req);
    if (!content.trim() && !toolCalls.length) throw new AIProviderError({ provider: "Gemini", model: req.model, type: "empty_response", detail: "Gemini returned no text or function-call content", requestId: req.requestId });
    const candidate = (Array.isArray(data.candidates) ? data.candidates[0] : undefined) as Record<string, unknown> | undefined;
    return { content, toolCalls, model: typeof data.modelVersion === "string" ? data.modelVersion : req.model, finishReason: typeof candidate?.finishReason === "string" ? candidate.finishReason : undefined, usage: usageFrom(data) };
  }

  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${modelPath(req.model, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: this.headers(req.requestId),
        body: JSON.stringify({
          ...contentsFor(req.messages, req.imageDataUrl),
          generationConfig: {
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
          },
        }),
        redirect: "error",
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) { throw providerErrorFromException("Gemini", req.model, error, req.requestId); }
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      if (!response.ok) throw providerErrorFromResponse("Gemini", req.model, response, detail, req.requestId);
      throw new AIProviderError({ provider: "Gemini", model: req.model, type: "empty_response", detail: "Gemini returned no stream body", requestId: req.requestId });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let yielded = false;
    const consume = (line: string): string => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return "";
      const payload = trimmed.slice(5).trim();
      if (!payload) return "";
      let data: Record<string, unknown>;
      try { data = JSON.parse(payload) as Record<string, unknown>; }
      catch (error) { throw providerErrorFromException("Gemini", req.model, error, req.requestId); }
      if (data.error && typeof data.error === "object") {
        const error = data.error as Record<string, unknown>;
        throw new AIProviderError({ provider: "Gemini", model: req.model, type: "provider_unavailable", detail: typeof error.message === "string" ? error.message : "Gemini stream failed", requestId: req.requestId });
      }
      if (data.usageMetadata) req.onUsage?.(usageFrom(data));
      return textFrom(data);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const text = consume(line);
          if (text) { yielded = true; yield text; }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split(/\r?\n/)) {
          const text = consume(line);
          if (text) { yielded = true; yield text; }
        }
      }
      if (!yielded) throw new AIProviderError({ provider: "Gemini", model: req.model, type: "empty_response", detail: "Gemini stream ended without text content", requestId: req.requestId });
    } catch (error) {
      try { await reader.cancel(); } catch { /* response already ended */ }
      throw error instanceof AIProviderError ? error : providerErrorFromException("Gemini", req.model, error, req.requestId);
    }
  }

  async transcribeAudio(input: { model: string; mimeType: string; base64: string; language?: string; signal?: AbortSignal }): Promise<AIProviderResponse> {
    const languageHint = input.language?.trim() ? ` The speaker's preferred language is ${input.language.trim().slice(0, 40)}.` : "";
    return this.generateAudioPrompt(input.model, [
      { text: `Transcribe the user's speech faithfully. Return only the spoken words, without commentary or markdown.${languageHint}` },
      { inlineData: { mimeType: input.mimeType, data: input.base64 } },
    ], input.signal);
  }

  async synthesizeSpeech(input: { model: string; text: string; voice: string; signal?: AbortSignal }): Promise<{ bytes: Buffer; mimeType: string; usage: AIProviderResponse["usage"] }> {
    const id = input.model.trim();
    const voice = input.voice.trim();
    if (!voice || voice.length > 80) throw new Error("GEMINI_TTS_VOICE_REQUIRED");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${modelPath(id, "generateContent")}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          contents: [{ parts: [{ text: input.text.slice(0, 6000) }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        }),
        redirect: "error",
        signal: input.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) { throw providerErrorFromException("Gemini", id, error); }
    if (!response.ok) throw providerErrorFromResponse("Gemini", id, response, await response.text().catch(() => ""));
    const data = await response.json() as Record<string, unknown>;
    const candidate = (Array.isArray(data.candidates) ? data.candidates[0] : undefined) as Record<string, unknown> | undefined;
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const audio = parts.map((part) => (part as Record<string, unknown>)?.inlineData).find((part) => part && typeof part === "object") as Record<string, unknown> | undefined;
    if (typeof audio?.data !== "string" || typeof audio.mimeType !== "string") throw new AIProviderError({ provider: "Gemini", model: id, type: "empty_response", detail: "Gemini returned no generated audio", requestId: undefined });
    return { bytes: Buffer.from(audio.data, "base64"), mimeType: audio.mimeType, usage: usageFrom(data) };
  }

  private async generateAudioPrompt(model: string, parts: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<AIProviderResponse> {
    const id = model.trim();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${modelPath(id, "generateContent")}`, { method: "POST", headers: this.headers(), body: JSON.stringify({ contents: [{ parts }] }), redirect: "error", signal: signal ?? AbortSignal.timeout(60_000) });
    } catch (error) { throw providerErrorFromException("Gemini", id, error); }
    if (!response.ok) throw providerErrorFromResponse("Gemini", id, response, await response.text().catch(() => ""));
    const data = await response.json() as Record<string, unknown>;
    const content = textFrom(data).trim();
    if (!content) throw new AIProviderError({ provider: "Gemini", model: id, type: "empty_response", detail: "Gemini returned no transcription" });
    return { content, model: typeof data.modelVersion === "string" ? data.modelVersion : id, finishReason: undefined, usage: usageFrom(data) };
  }
}
