// Server-side AI configuration. Keep provider names, model IDs and fallback
// policy in one place so a browser component can never accidentally select a
// provider credential or invent a model slug.

import "server-only";

import type { Db } from "@/lib/firebase/admin";
import { MODELS, createProvider, type AIProvider, type AIProviderRequest, type AIProviderResponse } from "@/lib/ai/groq";
import { OPENROUTER_MODELS, createCodingProvider } from "@/lib/ai/openrouter";
import { createRuntimeAgentRoute, createRuntimeAIRoute, readAIProviderConfig, type RuntimeAIRoute } from "@/lib/ai/runtime-config";
import { environmentProviders, CatalogValidatedProvider, type RegisteredProvider } from "@/lib/ai/provider-registry";
import { AIProviderError, type AIProviderName } from "@/lib/ai/provider-error";
import { getManagedProviderCatalogEntries, getManagedProviderRoutes } from "@/lib/ai/managed-providers";

export type AIRouteTarget = {
  provider: AIProviderName;
  model: string;
  client: AIProvider;
  providerId?: string;
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

/**
 * The admin OpenAI-compatible provider is operator-entered (base URL, model,
 * key) and is the most likely thing to be misconfigured. A wrong key or model
 * must never take the whole assistant offline: we treat its hard errors
 * (authentication, invalid_request) as fallback-eligible so the environment
 * providers (OpenRouter / Groq) can serve the request. The failure is still
 * logged, so the operator can see and fix it from the Admin panel.
 */
class FallbackSafeProvider implements AIProvider {
  readonly supportsToolCalls: boolean;
  constructor(private readonly inner: AIProvider) { this.supportsToolCalls = inner.supportsToolCalls === true; }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    try {
      return await this.inner.chat(req);
    } catch (error) {
      throw reclassifyAsFallbackEligible(error);
    }
  }

  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    try {
      if (!this.inner.streamChat) throw new Error("provider does not support streaming");
      yield* this.inner.streamChat(req);
    } catch (error) {
      throw reclassifyAsFallbackEligible(error);
    }
  }

  async healthCheck(model?: string): Promise<boolean> {
    return this.inner.healthCheck(model);
  }
}

function reclassifyAsFallbackEligible(error: unknown): unknown {
  if (error instanceof AIProviderError && (error.type === "authentication" || error.type === "invalid_request")) {
    return new AIProviderError({ ...error, retryable: true, fallbackEligible: true });
  }
  return error;
}

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
  const configuredTargets = targets.filter((target): target is AIRouteTarget => target !== null && Boolean(target.model));
  const known = new Set(configuredTargets.map((target) => target.provider));
  const additional = environmentProviders().filter((entry) => !known.has(entry.name as AIProviderName) && (coding ? entry.codingModel : entry.defaultModel)).map((entry) => ({ provider: entry.name as AIProviderName, providerId: entry.id, model: coding ? entry.codingModel : entry.defaultModel, client: entry.client }));
  return [...configuredTargets, ...additional].map((target) => ({ ...target, client: new CatalogValidatedProvider(target.client) }));
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
  let managedTargets: Awaited<ReturnType<typeof getManagedProviderRoutes>> = [];
  let runtimeRoute: RuntimeAIRoute | null = null;
  let runtimeConfig: Awaited<ReturnType<typeof readAIProviderConfig>> = null;

  if (d) {
    try {
      managedTargets = await getManagedProviderRoutes(d, coding ? "agent" : "chat");
    } catch (error) {
      console.error("[MATRIX] Managed AI provider registry could not be read; using remaining providers.", error instanceof Error ? error.message.slice(0, 160) : "unknown");
    }
    try {
      runtimeConfig = await readAIProviderConfig(d);
      runtimeRoute = createRuntimeAIRoute(runtimeConfig);
    } catch (error) {
      console.error(
        "[MATRIX] Admin AI provider settings could not be read; using environment fallbacks.",
        error instanceof Error ? error.message.slice(0, 160) : "unknown",
      );
    }
  }

  const managedRouteTargets: AIRouteTarget[] = managedTargets.map((target) => ({
    ...target,
    client: new FallbackSafeProvider(new CatalogValidatedProvider(target.client)),
  }));

  if (!runtimeRoute) {
    const configured = [...managedRouteTargets, ...envTargets];
    return preferFallback ? [...envTargets, ...managedRouteTargets] : configured.length ? configured : createAIRoutes(coding, preferFallback);
  }

  // Agent / coding requests use the dedicated Agent model when the admin has
  // saved one; otherwise they share the chat model.
  const effectiveRoute = coding && runtimeConfig?.agent_model
    ? (createRuntimeAgentRoute(runtimeConfig) ?? runtimeRoute)
    : runtimeRoute;

  const runtimeTargets: AIRouteTarget[] = [{ ...effectiveRoute, providerId: "compatible", client: new FallbackSafeProvider(new CatalogValidatedProvider(effectiveRoute.client)) }];
  // `preferFallback` is used by retry/probe flows; it deliberately puts the
  // environment provider first so the admin config is only used after the
  // fallback has been checked.
  return preferFallback
    ? [...envTargets, ...runtimeTargets, ...managedRouteTargets]
    : [...managedRouteTargets, ...runtimeTargets, ...envTargets];
}

/**
 * Routes used by the screenshot scanner. The admin OpenAI-compatible provider
 * is primary when configured (it should be a multimodal model), otherwise the
 * environment Groq vision model is used.
 */
export async function createScanRoutesFromDb(d: Db | null): Promise<AIRouteTarget[]> {
  const groq = createProvider();
  const envTarget: AIRouteTarget | null = groq && MODELS.vision
    ? { provider: "Groq", model: MODELS.vision, client: groq }
    : null;

  let runtimeRoute: RuntimeAIRoute | null = null;
  let managedTargets: Awaited<ReturnType<typeof getManagedProviderRoutes>> = [];
  if (d) {
    try {
      managedTargets = await getManagedProviderRoutes(d, "vision");
    } catch (error) {
      console.error("[MATRIX] Managed vision provider registry could not be read; using remaining providers.", error instanceof Error ? error.message.slice(0, 160) : "unknown");
    }
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

  const routes: AIRouteTarget[] = managedTargets.map((target) => ({ ...target, client: new FallbackSafeProvider(new CatalogValidatedProvider(target.client)) }));
  if (runtimeRoute) routes.push({ ...runtimeRoute, client: new FallbackSafeProvider(runtimeRoute.client) });
  if (envTarget) routes.push(envTarget);
  return routes;
}

export class AIConfigurationError extends Error {
  constructor(public readonly coding: boolean) {
    super(coding ? "No coding AI provider is configured" : "No general AI provider is configured");
    this.name = "AIConfigurationError";
  }
}


/** Runtime record first, then environment registry. Never contains public credentials. */
export async function providerCatalogEntries(d: Db | null): Promise<RegisteredProvider[]> {
  const entries = environmentProviders();
  if (d) {
    const config = await readAIProviderConfig(d);
    const route = createRuntimeAIRoute(config);
    if (config && route) entries.unshift({ id: "compatible", name: config.label || "OpenAI-compatible", client: route.client, baseUrl: config.base_url, defaultModel: config.model, codingModel: config.agent_model || config.model, visionModel: "" });
    entries.unshift(...await getManagedProviderCatalogEntries(d));
  }
  return entries;
}

export async function resolveSelectedAIRoute(d: Db | null, providerId: string, model: string): Promise<AIRouteTarget> {
  const entry = (await providerCatalogEntries(d)).find((item) => item.id === providerId);
  if (!entry) throw new AIProviderError({ provider: "OpenAI", model, type: "invalid_request", detail: "The selected provider is not configured on this server." });
  if (!entry.client.listModels || !(await entry.client.listModels()).some((item) => item.id === model)) {
    throw new AIProviderError({ provider: entry.name as AIProviderName, model, type: "invalid_request", status: 404, detail: `Model ${model} is not listed by ${entry.name}. Select a verified catalog entry.` });
  }
  return { provider: entry.name as AIProviderName, providerId: entry.id, model, client: new CatalogValidatedProvider(entry.client) };
}
