// =============================================================================
// Server-side AI routing.
//
// ROUTE ORDER (highest priority first)
//   1. The MAIN model — one admin-editable record (Gemini by default, or any
//      OpenAI-compatible / Anthropic endpoint). Read from Firestore, then from
//      the environment (GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY).
//   2. Admin-managed provider accounts (extra keys, per-model role flags).
//   3. Environment fallbacks (Groq for chat, native Gemini vision).
//
// OpenRouter is NOT part of the default chain. The main model is Google
// Gemini; an operator who prefers OpenRouter can point the main model at
// https://openrouter.ai/api/v1 from Admin → AI configuration, which is an
// explicit choice rather than a hard-coded default.
//
// Keep provider names, model IDs and fallback policy in one place so a browser
// component can never accidentally select a provider credential or invent a
// model slug.
// =============================================================================

import "server-only";

import type { Db } from "@/lib/firebase/admin";
import { MODELS, createProvider, type AIProvider, type AIProviderRequest, type AIProviderResponse } from "@/lib/ai/groq";
import {
  createRuntimeAgentRoute,
  createRuntimeAIRoute,
  createRuntimeVisionRoute,
  resolveMainModelConfig,
  type RuntimeAIRoute,
} from "@/lib/ai/runtime-config";
import { environmentProviders, CatalogValidatedProvider, type RegisteredProvider } from "@/lib/ai/provider-registry";
import { AIProviderError, type AIProviderName } from "@/lib/ai/provider-error";
import { getManagedProviderCatalogEntries, getManagedProviderRoutes } from "@/lib/ai/managed-providers";

export type AIRouteTarget = {
  provider: AIProviderName;
  model: string;
  client: AIProvider;
  providerId?: string;
};

/**
 * Static label shown when nothing is configured at all. It is never used to
 * make a request — it only keeps the UI honest about which model *would* be
 * used once credentials exist.
 */
export const AI_CONFIG = {
  general: {
    provider: "Gemini" as const,
    model: "gemini-2.5-flash",
    fallback: null,
  },
  coding: {
    provider: "Gemini" as const,
    model: "gemini-2.5-flash",
    fallbackProvider: "Groq" as const,
    fallbackModel: MODELS.chat,
  },
} as const;

/**
 * The admin main model is operator-entered and is the most likely thing to be
 * misconfigured. A wrong key or model must never take the whole assistant
 * offline: hard errors (authentication, invalid_request) stay
 * fallback-eligible so the remaining providers can serve the request. The
 * failure is still logged, so the operator sees it in Admin.
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
  console.info("[MATRIX] AI configuration", {
    mainModel: "admin-editable (system_settings/ai_provider), Gemini by default",
    gemini: keyConfigured(process.env.GEMINI_API_KEY) ? "configured" : "missing",
    geminiModel: process.env.GEMINI_MODEL?.trim() || AI_CONFIG.general.model,
    groq: keyConfigured(process.env.GROQ_API_KEY) ? "configured" : "missing",
    groqModel: MODELS.chat || "not configured",
    openRouter: keyConfigured(process.env.OPENROUTER_API_KEY) ? "configured (only used if selected)" : "not part of default routing",
    fallback: "main model → managed providers → Groq/vision fallbacks",
  });
}

/**
 * Environment-only routes, used when Firestore is unavailable. Gemini stays
 * first; Groq is the chat fallback. No OpenRouter.
 */
export function createAIRoutes(coding: boolean, preferFallback = false): AIRouteTarget[] {
  const known = new Set<string>();
  const envTargets: AIRouteTarget[] = environmentProviders()
    .filter((entry) => {
      // OpenRouter & Anthropic are no longer implicit defaults. They are
      // selected explicitly through the main-model record instead.
      if (entry.id === "openrouter") return false;
      return coding ? Boolean(entry.codingModel) : Boolean(entry.defaultModel);
    })
    .map((entry) => {
      known.add(entry.name);
      return {
        provider: entry.name as AIProviderName,
        providerId: entry.id,
        model: coding ? entry.codingModel : entry.defaultModel,
        client: entry.client,
      };
    })
    .map((target) => ({ ...target, client: new CatalogValidatedProvider(target.client) }));

  const ordered = [...envTargets].sort((a, b) => {
    const rank = (provider: AIProviderName) => (provider === "Gemini" ? 0 : provider === "Groq" ? 1 : 2);
    return rank(a.provider) - rank(b.provider);
  });
  void known;
  return preferFallback ? [...ordered].reverse() : ordered;
}

export function aiProviderConfigured(coding: boolean): boolean {
  return createAIRoutes(coding).length > 0;
}

/**
 * Build the route order for a request. The main model always leads; managed
 * provider accounts follow; environment fallbacks come last so a working
 * configuration is never silently bypassed.
 */
export async function createAIRoutesFromDb(
  d: Db | null,
  coding: boolean,
  preferFallback = false,
): Promise<AIRouteTarget[]> {
  const envTargets = createAIRoutes(coding, false);
  let managedTargets: Awaited<ReturnType<typeof getManagedProviderRoutes>> = [];
  let runtimeRoute: RuntimeAIRoute | null = null;
  let runtimeConfig: Awaited<ReturnType<typeof resolveMainModelConfig>> = null;

  if (d) {
    try {
      managedTargets = await getManagedProviderRoutes(d, coding ? "agent" : "chat");
    } catch (error) {
      console.error("[MATRIX] Managed AI provider registry could not be read; using remaining providers.", error instanceof Error ? error.message.slice(0, 160) : "unknown");
    }
    try {
      runtimeConfig = await resolveMainModelConfig(d);
      runtimeRoute = createRuntimeAIRoute(runtimeConfig);
    } catch (error) {
      console.error(
        "[MATRIX] Main model settings could not be read; using environment providers.",
        error instanceof Error ? error.message.slice(0, 160) : "unknown",
      );
    }
  } else {
    // No database handle: the environment is the only configuration source.
    try {
      runtimeConfig = await resolveMainModelConfig(null);
      runtimeRoute = createRuntimeAIRoute(runtimeConfig);
    } catch { /* fall through to env targets */ }
  }

  // Managed models were already catalog-verified (or explicitly approved via
  // allow_unverified) when saved; wrapping them in CatalogValidatedProvider
  // would break endpoints that do not expose /models at runtime.
  const managedRouteTargets: AIRouteTarget[] = managedTargets.map((target) => ({
    ...target,
    client: new FallbackSafeProvider(target.client),
  }));

  if (!runtimeRoute) {
    const configured = [...managedRouteTargets, ...envTargets];
    return preferFallback ? [...envTargets, ...managedRouteTargets] : configured;
  }

  // Agent / coding requests use the dedicated Agent model when the admin has
  // saved one; otherwise they share the chat model.
  const effectiveRoute = coding && runtimeConfig?.agent_model
    ? (createRuntimeAgentRoute(runtimeConfig) ?? runtimeRoute)
    : runtimeRoute;

  // The main model is already catalog-validated at save time; wrapping it in
  // CatalogValidatedProvider would re-hit the provider catalog on every cold
  // request, so it keeps the fallback-safe wrapper only.
  const mainTarget: AIRouteTarget = {
    ...effectiveRoute,
    providerId: `main-${effectiveRoute.kind}`,
    client: new FallbackSafeProvider(effectiveRoute.client),
  };
  const remaining = [...managedRouteTargets, ...envTargets].filter(
    (target) => !(target.provider === mainTarget.provider && target.model === mainTarget.model),
  );
  return preferFallback ? [...remaining, mainTarget] : [mainTarget, ...remaining];
}

/**
 * Routes used by the screenshot scanner. The main model's vision model (or the
 * chat model when it is multimodal) is primary; managed vision models and the
 * Groq vision fallback follow.
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
      runtimeRoute = createRuntimeVisionRoute(await resolveMainModelConfig(d));
    } catch (error) {
      console.error(
        "[MATRIX] Main model settings could not be read; using environment vision fallback.",
        error instanceof Error ? error.message.slice(0, 160) : "unknown",
      );
    }
  } else {
    try {
      runtimeRoute = createRuntimeVisionRoute(await resolveMainModelConfig(null));
    } catch { /* environment vision fallback below */ }
  }

  const routes: AIRouteTarget[] = managedTargets.map((target) => ({ ...target, client: new FallbackSafeProvider(target.client) }));
  if (runtimeRoute) routes.unshift({ ...runtimeRoute, providerId: `main-${runtimeRoute.kind}`, client: new FallbackSafeProvider(runtimeRoute.client) });
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
  const entries = environmentProviders().filter((entry) => entry.id !== "openrouter");
  if (d) {
    const config = await resolveMainModelConfig(d);
    const route = createRuntimeAIRoute(config);
    if (config && route) {
      entries.unshift({
        id: `main-${config.kind}`,
        name: config.label || `${config.kind} (main model)`,
        client: route.client,
        baseUrl: config.base_url,
        defaultModel: config.model,
        codingModel: config.agent_model || config.model,
        visionModel: config.vision_model || config.model,
      });
    }
    entries.unshift(...await getManagedProviderCatalogEntries(d));
  } else {
    const config = await resolveMainModelConfig(null);
    const route = createRuntimeAIRoute(config);
    if (config && route) {
      entries.unshift({
        id: `main-${config.kind}`,
        name: config.label || `${config.kind} (main model)`,
        client: route.client,
        baseUrl: config.base_url,
        defaultModel: config.model,
        codingModel: config.agent_model || config.model,
        visionModel: config.vision_model || config.model,
      });
    }
  }
  return entries;
}

export async function resolveSelectedAIRoute(d: Db | null, providerId: string, model: string): Promise<AIRouteTarget> {
  const entry = (await providerCatalogEntries(d)).find((item) => item.id === providerId);
  if (!entry) throw new AIProviderError({ provider: "Gemini", model, type: "invalid_request", detail: "The selected provider is not configured on this server." });
  const explicitlyConfigured = [entry.defaultModel, entry.codingModel, entry.visionModel].filter(Boolean).includes(model);
  if (explicitlyConfigured) {
    return { provider: entry.name as AIProviderName, providerId: entry.id, model, client: new FallbackSafeProvider(entry.client) };
  }
  if (!entry.client.listModels || !(await entry.client.listModels()).some((item) => item.id === model)) {
    throw new AIProviderError({ provider: entry.name as AIProviderName, model, type: "invalid_request", status: 404, detail: `Model ${model} is not listed by ${entry.name}. Select a verified catalog entry.` });
  }
  return { provider: entry.name as AIProviderName, providerId: entry.id, model, client: new CatalogValidatedProvider(entry.client) };
}
