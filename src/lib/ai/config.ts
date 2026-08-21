// Server-side AI configuration. Keep provider names, model IDs and fallback
// policy in one place so a browser component can never accidentally select a
// provider credential or invent a model slug.

import "server-only";

import { MODELS, createProvider, type AIProvider } from "@/lib/ai/groq";
import { OPENROUTER_MODELS, createCodingProvider } from "@/lib/ai/openrouter";
import type { AIProviderName } from "@/lib/ai/provider-error";

export type AIRouteTarget = {
  provider: AIProviderName;
  model: string;
  client: AIProvider;
};

export const AI_CONFIG = {
  general: {
    provider: "Groq" as const,
    model: MODELS.chat,
    fallback: null,
  },
  coding: {
    provider: "OpenRouter" as const,
    model: OPENROUTER_MODELS.coding,
    fallbackProvider: "Groq" as const,
    fallbackModel: MODELS.chat,
  },
} as const;

const CONFIG_LOGGED = "__matrixAiConfigurationLogged";

function keyConfigured(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return Boolean(normalized) && !normalized.endsWith("...") && !normalized.startsWith("YOUR-") && !normalized.startsWith("replace-with");
}

/**
 * Called on the first server request rather than at module import so build
 * output never bakes environment values into a client bundle. It deliberately
 * reports presence and model configuration only — never a key or token.
 */
export function logAIConfiguration(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[CONFIG_LOGGED]) return;
  globalState[CONFIG_LOGGED] = true;
  const openRouterConfigured = keyConfigured(process.env.OPENROUTER_API_KEY);
  const groqConfigured = keyConfigured(process.env.GROQ_API_KEY);
  console.info("[MATRIX] AI configuration", {
    openRouter: openRouterConfigured ? "configured" : "missing",
    openRouterModel: OPENROUTER_MODELS.coding,
    openRouterBilling: OPENROUTER_MODELS.coding.endsWith(":free") ? "free" : "paid-or-custom",
    groq: groqConfigured ? "configured" : "missing",
    groqModel: MODELS.chat,
    fallback: "OpenRouter → Groq when transient",
  });
}

/** OpenRouter is primary for Agent/coding; Groq is only its safe fallback. */
export function createAIRoutes(coding: boolean, preferFallback = false): AIRouteTarget[] {
  const openRouter = coding ? createCodingProvider() : null;
  const groq = createProvider();
  const primary: AIRouteTarget | null = coding
    ? openRouter ? { provider: "OpenRouter", model: AI_CONFIG.coding.model, client: openRouter } : null
    : groq ? { provider: "Groq", model: AI_CONFIG.general.model, client: groq } : null;
  const fallback: AIRouteTarget | null = coding
    ? groq ? { provider: "Groq", model: AI_CONFIG.coding.fallbackModel, client: groq } : null
    : null;

  const targets = preferFallback ? [fallback, primary] : [primary, fallback];
  return targets.filter((target): target is AIRouteTarget => target !== null);
}

export function aiProviderConfigured(coding: boolean): boolean {
  return createAIRoutes(coding).length > 0;
}

export class AIConfigurationError extends Error {
  constructor(public readonly coding: boolean) {
    super(coding ? "No coding AI provider is configured" : "No general AI provider is configured");
    this.name = "AIConfigurationError";
  }
}
