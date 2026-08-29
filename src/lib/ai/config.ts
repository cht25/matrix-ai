// Server-side AI configuration. Keep provider names, model IDs and fallback
// policy in one place so a browser component can never accidentally select a
// provider credential or invent a model slug.

import "server-only";

import type { Db } from "@/lib/firebase/admin";
import { MODELS, createProvider, type AIProvider } from "@/lib/ai/groq";
import { OPENROUTER_MODELS, createCodingProvider } from "@/lib/ai/openrouter";
import { createRuntimeAIRoute, readAIProviderConfig, type RuntimeAIRoute } from "@/lib/ai/runtime-config";
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

/** Environment-keyed fallback routes: OpenRouter for Agent/coding, Groq for general chat. */
export function createAIRoutes(coding: boolean, preferFallback = false): AIRouteTarget[] {
  const openRouter = createCodingProvider();
  const groq = createProvider();

  let primary: AIRouteTarget | null = null;
  let fallback: AIRouteTarget | null = null;

  if (coding) {
    if (openRouter) {
      primary = { provider: "OpenRouter", model: AI_CONFIG.coding.model, client: openRouter };
      if (groq) {
        fallback = { provider: "Groq", model: AI_CONFIG.coding.fallbackModel, client: groq };
      }
    } else if (groq) {
      primary = { provider: "Groq", model: AI_CONFIG.coding.fallbackModel, client: groq };
    }
  } else {
    if (groq) {
      primary = { provider: "Groq", model: AI_CONFIG.general.model, client: groq };
      if (openRouter) {
        fallback = { provider: "OpenRouter", model: AI_CONFIG.coding.model, client: openRouter };
      }
    } else if (openRouter) {
      primary = { provider: "OpenRouter", model: AI_CONFIG.coding.model, client: openRouter };
    }
  }

  const targets = preferFallback ? [fallback, primary] : [primary, fallback];
  return targets.filter((target): target is AIRouteTarget => target !== null);
}

export function aiProviderConfigured(coding: boolean): boolean {
  return createAIRoutes(coding).length > 0;
}

/**
 * Build the route order for a request, giving an admin-configured
 * OpenAI-compatible provider priority when one is saved in Firestore.
 *
 * `d` may be `null` when the Firestore accessor is unavailable (for example
 * the unauthenticated health probe before the app is configured); in that case
 * the environment fallback providers are the only routes considered.
 */
export async function createAIRoutesFromDb(
  d: Db | null,
  coding: boolean,
  preferFallback = false,
): Promise<AIRouteTarget[]> {
  const envTargets = createAIRoutes(coding, false);
  let runtimeRoute: RuntimeAIRoute | null = null;

  if (d) {
    try {
      const config = await readAIProviderConfig(d);
      runtimeRoute = createRuntimeAIRoute(config);
    } catch (error) {
      console.error(
        "[MATRIX] Admin AI provider settings could not be read; using environment fallbacks.",
        error instanceof Error ? error.message.slice(0, 160) : "unknown",
      );
    }
  }

  if (!runtimeRoute) return createAIRoutes(coding, preferFallback);

  const runtimeTargets: AIRouteTarget[] = [runtimeRoute];
  // `preferFallback` is used by retry/probe flows; it deliberately puts the
  // environment provider first so the admin config is only used after the
  // fallback has been checked.
  return preferFallback ? [...envTargets, ...runtimeTargets] : [...runtimeTargets, ...envTargets];
}

/**
 * Routes used by the screenshot scanner. The admin OpenAI-compatible provider
 * is primary when configured (it should be a multimodal model), otherwise the
 * environment Groq vision model is used.
 */
export async function createScanRoutesFromDb(d: Db | null): Promise<AIRouteTarget[]> {
  const groq = createProvider();
  const envTarget: AIRouteTarget | null = groq
    ? { provider: "Groq", model: MODELS.vision, client: groq }
    : null;

  let runtimeRoute: RuntimeAIRoute | null = null;
  if (d) {
    try {
      const config = await readAIProviderConfig(d);
      runtimeRoute = createRuntimeAIRoute(config);
    } catch (error) {
      console.error(
        "[MATRIX] Admin AI provider settings could not be read; using environment vision fallback.",
        error instanceof Error ? error.message.slice(0, 160) : "unknown",
      );
    }
  }

  const routes: AIRouteTarget[] = [];
  if (runtimeRoute) routes.push(runtimeRoute);
  if (envTarget) routes.push(envTarget);
  return routes;
}

export class AIConfigurationError extends Error {
  constructor(public readonly coding: boolean) {
    super(coding ? "No coding AI provider is configured" : "No general AI provider is configured");
    this.name = "AIConfigurationError";
  }
}
