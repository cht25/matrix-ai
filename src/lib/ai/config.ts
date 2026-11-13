// =============================================================================
// Server-side AI routing — Tiered GLM + `openai/gpt-oss-120b` Architecture.
//
// TIERED ROUTE ORDER
//   • High-load, Coding, Web Development, Agent/Build, Orchestrator, Vision:
//       1. GLM (`glm-4.7` / `glm-4.6v` or admin-configured primary model)
//       2. Admin-managed provider accounts
//       3. `openai/gpt-oss-120b` & secondary environment fallbacks
//
//   • Low-load, Fast Everyday Chat & Lightweight Tasks:
//       1. `openai/gpt-oss-120b` (`GROQ_API_KEY` / `GPT_OSS_API_KEY`) — or custom
//          admin non-GLM main model when explicitly overridden in Firestore
//       2. GLM (`glm-4.7`) & admin-managed provider accounts as automatic fallbacks
//
// Explicit model selection from the model picker (`resolveSelectedAIRoute`) and
// all admin-managed providers continue working across every protocol.
// =============================================================================

import "server-only";

import type { Db } from "@/lib/firebase/admin";
import { GPT_OSS_DEFAULT_MODEL, MODELS, createProvider, type AIProvider, type AIProviderRequest, type AIProviderResponse } from "@/lib/ai/groq";
import { GLM_DEFAULT_CODING_MODEL, GLM_DEFAULT_MODEL, GLM_DEFAULT_VISION_MODEL } from "@/lib/ai/glm";
import type { WorkloadTier } from "@/lib/ai/router";
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
  tier?: WorkloadTier;
};

/**
 * Shipped defaults displayed when no credentials have been set yet.
 */
export const AI_CONFIG = {
  general: {
    provider: "Groq" as const,
    model: GPT_OSS_DEFAULT_MODEL,
    fallback: GLM_DEFAULT_MODEL,
  },
  coding: {
    provider: "GLM" as const,
    model: GLM_DEFAULT_CODING_MODEL,
    fallbackProvider: "Groq" as const,
    fallbackModel: GPT_OSS_DEFAULT_MODEL,
  },
  vision: {
    provider: "GLM" as const,
    model: GLM_DEFAULT_VISION_MODEL,
  },
} as const;

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

export function logAIConfiguration(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[CONFIG_LOGGED]) return;
  globalState[CONFIG_LOGGED] = true;
  console.info("[MATRIX] AI configuration", {
    architecture: "GLM (high-load / coding / web-dev / vision) + openai/gpt-oss-120b (low-load fast)",
    glm: keyConfigured(process.env.GLM_API_KEY) ? "configured" : "missing",
    glmModel: process.env.GLM_MODEL?.trim() || AI_CONFIG.coding.model,
    lowTaskEngine: keyConfigured(process.env.GROQ_API_KEY) || keyConfigured(process.env.GPT_OSS_API_KEY) ? "configured" : "missing",
    lowTaskModel: MODELS.chat || GPT_OSS_DEFAULT_MODEL,
    fallback: "tiered GLM ↔ gpt-oss-120b → managed providers → configured environment providers",
  });
}

function isLowTierTarget(target: AIRouteTarget): boolean {
  return target.providerId === "groq" || target.providerId === "gpt-oss" || /gpt-oss-120b/i.test(target.model);
}

/**
 * Environment-only routes, ordered by workload tier (`"high"` → GLM first;
 * `"low"` → `openai/gpt-oss-120b` first, with GLM as resilient fallback).
 */
export function createAIRoutes(
  coding: boolean,
  preferFallback = false,
  tier: WorkloadTier = coding ? "high" : "low",
): AIRouteTarget[] {
  const effectiveTier: WorkloadTier = coding ? "high" : tier;
  const envTargets: AIRouteTarget[] = environmentProviders()
    .filter((entry) => {
      // Gemini and OpenRouter are never implicit defaults; they are used only
      // when explicitly selected by provider/model ID or saved in Admin.
      if (entry.id === "openrouter" || entry.id === "gemini") return false;
      return coding ? Boolean(entry.codingModel) : Boolean(entry.defaultModel);
    })
    .map((entry) => {
      const targetModel = coding ? entry.codingModel : entry.defaultModel;
      const client = entry.id === "glm"
        ? new FallbackSafeProvider(entry.client)
        : new CatalogValidatedProvider(entry.client);
      return {
        provider: entry.name as AIProviderName,
        providerId: entry.id,
        model: targetModel,
        client,
        tier: entry.id === "glm" ? "high" : (entry.id === "groq" || entry.id === "gpt-oss" ? "low" : effectiveTier),
      };
    });

  const ordered = [...envTargets].sort((a, b) => {
    if (effectiveTier === "high") {
      const highRank = (t: AIRouteTarget) => (t.provider === "GLM" ? 0 : isLowTierTarget(t) ? 1 : 2);
      return highRank(a) - highRank(b);
    }
    const lowRank = (t: AIRouteTarget) => (isLowTierTarget(t) ? 0 : t.provider === "GLM" ? 1 : 2);
    return lowRank(a) - lowRank(b);
  });

  return preferFallback ? [...ordered].reverse() : ordered;
}

export function aiProviderConfigured(coding: boolean): boolean {
  return createAIRoutes(coding).length > 0;
}

/**
 * Build the route order for a request:
 *   • Coding / web-dev / high-load (`coding || tier === "high"`):
 *       GLM (or admin main/agent model) → managed providers → `gpt-oss-120b` fallback
 *   • Low-load (`!coding && tier === "low"`):
 *       - Custom non-GLM admin DB override leads when explicitly saved in Firestore.
 *       - Otherwise `openai/gpt-oss-120b` leads when configured, with GLM & managed
 *         providers standing by as automatic fallbacks!
 */
export async function createAIRoutesFromDb(
  d: Db | null,
  coding: boolean,
  preferFallback = false,
  tier: WorkloadTier = coding ? "high" : "low",
): Promise<AIRouteTarget[]> {
  const effectiveTier: WorkloadTier = coding ? "high" : tier;
  const envTargets = createAIRoutes(coding, false, effectiveTier);
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
    try {
      runtimeConfig = await resolveMainModelConfig(null);
      runtimeRoute = createRuntimeAIRoute(runtimeConfig);
    } catch { /* fall through to env targets */ }
  }

  const managedRouteTargets: AIRouteTarget[] = managedTargets.map((target) => ({
    ...target,
    client: new FallbackSafeProvider(target.client),
  }));

  if (!runtimeRoute) {
    // No main-model record resolved: for low-load tasks keep low-tier env target
    // ahead of fallback pools unless managed chat providers were explicitly configured
    // without an environment low-tier engine.
    const lowEnvLead = effectiveTier === "low" ? envTargets.find(isLowTierTarget) : undefined;
    if (lowEnvLead && managedRouteTargets.length === 0) {
      return preferFallback ? [...envTargets].reverse() : envTargets;
    }
    const configured = [...managedRouteTargets, ...envTargets];
    return preferFallback ? [...envTargets, ...managedRouteTargets] : configured;
  }

  const effectiveRoute = coding && runtimeConfig?.agent_model
    ? (createRuntimeAgentRoute(runtimeConfig) ?? runtimeRoute)
    : runtimeRoute;

  const mainTarget: AIRouteTarget = {
    ...effectiveRoute,
    providerId: `main-${effectiveRoute.kind}`,
    client: new FallbackSafeProvider(effectiveRoute.client),
    tier: "high",
  };

  const dedupe = (list: AIRouteTarget[]) => {
    const seen = new Set<string>();
    return list.filter((item) => {
      const key = `${item.provider}:${item.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Low-load tier offload to `openai/gpt-oss-120b` whenever the main model is GLM
  // (either from environment or database) and a low-tier `gpt-oss-120b` target is ready.
  const lowTierTarget = effectiveTier === "low" ? envTargets.find(isLowTierTarget) : undefined;
  const customNonGlmDbOverride = runtimeConfig?.source === "database" && runtimeConfig.kind !== "glm";

  if (effectiveTier === "low" && lowTierTarget && !customNonGlmDbOverride) {
    const configuredLowModel = runtimeConfig?.low_task_model?.trim();
    const primaryLow: AIRouteTarget = configuredLowModel && configuredLowModel !== lowTierTarget.model
      ? { ...lowTierTarget, model: configuredLowModel, tier: "low" }
      : { ...lowTierTarget, tier: "low" };
    const orderedLow = dedupe([primaryLow, mainTarget, ...managedRouteTargets, ...envTargets]);
    return preferFallback ? [...orderedLow].reverse() : orderedLow;
  }

  const orderedHigh = dedupe([mainTarget, ...managedRouteTargets, ...envTargets]);
  return preferFallback ? [...orderedHigh].reverse() : orderedHigh;
}

/**
 * Routes used by the screenshot scanner and chat vision attachments.
 * GLM vision (`glm-4.6v` or admin-configured vision model) leads, followed by
 * managed vision models and Groq vision fallback.
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

/** Runtime record first, then managed & environment registries. Never contains public credentials. */
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
  if (!entry) throw new AIProviderError({ provider: "GLM", model, type: "invalid_request", detail: "The selected provider is not configured on this server." });
  const explicitlyConfigured = [entry.defaultModel, entry.codingModel, entry.visionModel].filter(Boolean).includes(model);
  if (explicitlyConfigured) {
    return { provider: entry.name as AIProviderName, providerId: entry.id, model, client: new FallbackSafeProvider(entry.client) };
  }
  if (!entry.client.listModels || !(await entry.client.listModels()).some((item) => item.id === model)) {
    throw new AIProviderError({ provider: entry.name as AIProviderName, model, type: "invalid_request", status: 404, detail: `Model ${model} is not listed by ${entry.name}. Select a verified catalog entry.` });
  }
  return { provider: entry.name as AIProviderName, providerId: entry.id, model, client: new CatalogValidatedProvider(entry.client) };
}
