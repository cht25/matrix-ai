import "server-only";
import type { AIProvider } from "@/lib/ai/groq";
import { createProvider, GPT_OSS_DEFAULT_MODEL, MODELS } from "@/lib/ai/groq";
import {
  GLMProvider,
  GLM_DEFAULT_CODING_MODEL,
  GLM_DEFAULT_MODEL,
  GLM_DEFAULT_VISION_MODEL,
  resolveGlmBaseUrl,
} from "@/lib/ai/glm";
import { createOpenAICompatibleProvider } from "@/lib/ai/openai";
import { GeminiProvider, GEMINI_API_BASE_URL } from "@/lib/ai/gemini";
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

/**
 * Environment-registered providers.
 *
 * Primary shipped tiers:
 *   1. GLM (`GLM_API_KEY`) — high-end reasoning, coding, web development, Agent, and vision.
 *   2. Groq / `openai/gpt-oss-120b` (`GROQ_API_KEY` or `GPT_OSS_API_KEY`) — fast low-load tasks.
 *
 * Additional configured providers (OpenAI, Anthropic, Ollama, or explicit Gemini)
 * remain available in the model selector and fallback pool when credentials exist.
 */
export function environmentProviders(): RegisteredProvider[] {
  const result: RegisteredProvider[] = [];

  const glmKey = configured(process.env.GLM_API_KEY);
  if (glmKey) {
    const baseUrl = resolveGlmBaseUrl(process.env.GLM_BASE_URL);
    const defaultModel = process.env.GLM_MODEL?.trim() || GLM_DEFAULT_MODEL;
    const codingModel = process.env.GLM_CODING_MODEL?.trim() || defaultModel || GLM_DEFAULT_CODING_MODEL;
    const visionModel = process.env.GLM_VISION_MODEL?.trim() || GLM_DEFAULT_VISION_MODEL;
    result.push({
      id: "glm",
      name: "GLM",
      client: new GLMProvider(glmKey, baseUrl, defaultModel),
      baseUrl,
      defaultModel,
      codingModel,
      visionModel,
    });
  }

  const gptOssBaseUrl = process.env.GPT_OSS_BASE_URL?.trim();
  const gptOssDedicatedKey = configured(process.env.GPT_OSS_API_KEY);
  const groq = createProvider();
  if (gptOssDedicatedKey && gptOssBaseUrl) {
    const lowModel = process.env.GPT_OSS_MODEL?.trim() || GPT_OSS_DEFAULT_MODEL;
    result.push({
      id: "gpt-oss",
      name: "OpenAI",
      client: createOpenAICompatibleProvider({ apiKey: gptOssDedicatedKey, baseUrl: gptOssBaseUrl, label: "gpt-oss-120b", model: lowModel }),
      baseUrl: gptOssBaseUrl,
      defaultModel: lowModel,
      codingModel: lowModel,
      visionModel: "",
    });
  } else if (groq) {
    result.push({
      id: "groq",
      name: "Groq",
      client: groq,
      baseUrl: "https://api.groq.com/openai/v1",
      defaultModel: MODELS.chat,
      codingModel: process.env.GROQ_CODING_MODEL?.trim() || MODELS.chat,
      visionModel: MODELS.vision,
    });
  }

  const openaiKey = configured(process.env.OPENAI_API_KEY);
  if (openaiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    const model = process.env.OPENAI_MODEL?.trim() || "";
    result.push({
      id: "openai",
      name: "OpenAI",
      client: createOpenAICompatibleProvider({ apiKey: openaiKey, baseUrl, label: "OpenAI", model }),
      baseUrl,
      defaultModel: model,
      codingModel: process.env.OPENAI_CODING_MODEL?.trim() || model,
      visionModel: process.env.OPENAI_VISION_MODEL?.trim() || "",
    });
  }

  const anthropicKey = configured(process.env.ANTHROPIC_API_KEY);
  if (anthropicKey) {
    const model = process.env.ANTHROPIC_MODEL?.trim() || "";
    result.push({
      id: "anthropic",
      name: "Anthropic",
      client: new AnthropicProvider(anthropicKey),
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: model,
      codingModel: model,
      visionModel: model,
    });
  }

  // Optional secondary provider: never primary unless explicitly selected by ID.
  const geminiKey = configured(process.env.GEMINI_API_KEY);
  if (geminiKey) {
    const baseUrl = GEMINI_API_BASE_URL;
    const model = process.env.GEMINI_MODEL?.trim() || "";
    const codingModel = process.env.GEMINI_CODING_MODEL?.trim() || model;
    result.push({
      id: "gemini",
      name: "Gemini",
      client: new GeminiProvider(geminiKey),
      baseUrl,
      defaultModel: model,
      codingModel,
      visionModel: process.env.GEMINI_VISION_MODEL?.trim() || "",
    });
  }

  const ollamaBase = process.env.OLLAMA_BASE_URL?.trim();
  if (ollamaBase) {
    const model = process.env.OLLAMA_MODEL?.trim() || "";
    result.push({
      id: "ollama",
      name: "Ollama",
      client: createOpenAICompatibleProvider({
        apiKey: configured(process.env.OLLAMA_API_KEY) || "local-no-auth",
        baseUrl: ollamaBase,
        label: "Ollama",
        model,
      }),
      baseUrl: ollamaBase,
      defaultModel: model,
      codingModel: model,
      visionModel: process.env.OLLAMA_VISION_MODEL?.trim() || "",
    });
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
      const typedName = name === "GLM" || name === "Gemini" || name === "Ollama" || name === "Anthropic" || name === "Groq" ? name : "OpenAI";
      throw new AIProviderError({
        provider: typedName,
        model,
        type: "invalid_request",
        status: 404,
        detail: `Model ${model} is not listed by the configured provider. Select an available model in Models.`,
      });
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
