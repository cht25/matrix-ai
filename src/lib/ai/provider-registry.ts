import "server-only";
import type { AIProvider } from "@/lib/ai/groq";
import { createProvider, MODELS } from "@/lib/ai/groq";
import { createCodingProvider, OPENROUTER_MODELS } from "@/lib/ai/openrouter";
import { createOpenAICompatibleProvider } from "@/lib/ai/openai";
import { GeminiProvider } from "@/lib/ai/gemini";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { AIProviderError } from "@/lib/ai/provider-error";

export type RegisteredProvider = {
  id: string;
  name: string;
  client: AIProvider;
  baseUrl: string;
  defaultModel: string;
  codingModel: string;
  visionModel: string;
};

function configured(value: string | undefined): string {
  const key = value?.trim() ?? "";
  return key && !key.startsWith("YOUR-") && !key.startsWith("replace-with") && !key.includes("...") ? key : "";
}

/** No provider is enabled without a credential (Ollama explicitly needs a URL). */
export function environmentProviders(): RegisteredProvider[] {
  const result: RegisteredProvider[] = [];
  const groq = createProvider();
  if (groq) result.push({ id: "groq", name: "Groq", client: groq, baseUrl: "https://api.groq.com/openai/v1", defaultModel: MODELS.chat, codingModel: process.env.GROQ_CODING_MODEL?.trim() || MODELS.chat, visionModel: MODELS.vision });
  const router = createCodingProvider();
  if (router) result.push({ id: "openrouter", name: "OpenRouter", client: router, baseUrl: "https://openrouter.ai/api/v1", defaultModel: process.env.OPENROUTER_CHAT_MODEL?.trim() || OPENROUTER_MODELS.coding, codingModel: OPENROUTER_MODELS.coding, visionModel: "" });
  const openaiKey = configured(process.env.OPENAI_API_KEY);
  if (openaiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    const model = process.env.OPENAI_MODEL?.trim() || "";
    result.push({ id: "openai", name: "OpenAI", client: createOpenAICompatibleProvider({ apiKey: openaiKey, baseUrl, label: "OpenAI", model }), baseUrl, defaultModel: model, codingModel: process.env.OPENAI_CODING_MODEL?.trim() || model, visionModel: process.env.OPENAI_VISION_MODEL?.trim() || "" });
  }
  const geminiKey = configured(process.env.GEMINI_API_KEY);
  if (geminiKey) {
    const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    const model = process.env.GEMINI_MODEL?.trim() || "";
    const codingModel = process.env.GEMINI_CODING_MODEL?.trim() || model;
    result.push({ id: "gemini", name: "Gemini", client: new GeminiProvider(geminiKey), baseUrl, defaultModel: model, codingModel, visionModel: process.env.GEMINI_VISION_MODEL?.trim() || "" });
  }
  const anthropicKey = configured(process.env.ANTHROPIC_API_KEY);
  if (anthropicKey) {
    const model = process.env.ANTHROPIC_MODEL?.trim() || "";
    result.push({ id: "anthropic", name: "Anthropic", client: new AnthropicProvider(anthropicKey), baseUrl: "https://api.anthropic.com/v1", defaultModel: model, codingModel: model, visionModel: model });
  }
  const ollamaBase = process.env.OLLAMA_BASE_URL?.trim();
  if (ollamaBase) {
    const model = process.env.OLLAMA_MODEL?.trim() || "";
    result.push({ id: "ollama", name: "Ollama", client: createOpenAICompatibleProvider({ apiKey: configured(process.env.OLLAMA_API_KEY) || "local-no-auth", baseUrl: ollamaBase, label: "Ollama", model }), baseUrl: ollamaBase, defaultModel: model, codingModel: model, visionModel: process.env.OLLAMA_VISION_MODEL?.trim() || "" });
  }
  return result;
}

/** Preflight exact model IDs. Listing is cached; actual completion still checks entitlement. */
export class CatalogValidatedProvider implements AIProvider {
  private verified = new Map<string, number>();
  readonly supportsToolCalls: boolean;
  constructor(private readonly inner: AIProvider) { this.supportsToolCalls = inner.supportsToolCalls === true; }
  private async verify(model: string) {
    if (!this.inner.listModels) throw new Error("Provider does not expose a model catalog");
    const expires = this.verified.get(model) ?? 0;
    if (expires > Date.now()) return;
    const models = await this.inner.listModels();
    if (!models.some((item) => item.id === model)) {
      const name = (this.inner as AIProvider & { providerName?: string }).providerName ?? "provider";
      throw new AIProviderError({ provider: name === "Gemini" || name === "Ollama" || name === "Anthropic" ? name : "OpenAI", model, type: "invalid_request", status: 404, detail: `Model ${model} is not listed by the configured provider. Select an available model in Models.` });
    }
    this.verified.set(model, Date.now() + 300_000);
  }
  async chat(req: Parameters<AIProvider["chat"]>[0]) { await this.verify(req.model); return this.inner.chat(req); }
  async *streamChat(req: Parameters<NonNullable<AIProvider["streamChat"]>>[0]) {
    await this.verify(req.model);
    if (!this.inner.streamChat) throw new Error("Provider does not support streaming");
    yield* this.inner.streamChat(req);
  }
  async healthCheck(model?: string) { return this.inner.healthCheck(model); }
  async listModels() { return this.inner.listModels?.() ?? []; }
}
