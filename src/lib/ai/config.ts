// Server-side AI routes: GLM-5-Turbo is the Chat and Agent default.
// User/Admin-selected alternatives remain explicit; no automatic OSS substitution.

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
    provider: "GLM" as const,
    model: GLM_DEFAULT_MODEL,
    fallback: "",
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
    architecture: "GLM-5-Turbo primary for Chat and Agent; alternative models only by explicit selection",
    glm: keyConfigured(process.env.ZAI_API_KEY) || keyConfigured(process.env.GLM_API_KEY) ? "configured" : "missing",
    glmModel: process.env.GLM_MODEL?.trim() || AI_CONFIG.coding.model,
    lowTaskEngine: keyConfigured(process.env.GROQ_API_KEY) || keyConfigured(process.env.GPT_OSS_API_KEY) ? "configured" : "missing",
    lowTaskModel: MODELS.chat || GPT_OSS_DEFAULT_MODEL,
    fallback: "off by default; explicit alternative model selection or Try another model only",
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
  _tier: WorkloadTier = "high",
): AIRouteTarget[] {
  const providers = environmentProviders();
  const glm = providers.find((entry) => entry.id === "glm");
  const primary = glm ? [{ provider: "GLM" as const, providerId: glm.id,
    model: coding ? glm.codingModel : glm.defaultModel, client: glm.client, tier: "high" as const }] : [];
  // Other configured providers remain selectable. They are never implicit
  // substitutes for an absent or failing GLM; only an explicit retry requests
  // an alternative, and the gateway surfaces the actual provider in its reply.
  if (!preferFallback) return primary;
  const alternatives: AIRouteTarget[] = providers.filter((entry) => entry.id !== "glm" && (coding ? entry.codingModel : entry.defaultModel))
    .map((entry) => ({ provider: entry.name as AIProviderName, providerId: entry.id,
      model: coding ? entry.codingModel : entry.defaultModel, client: entry.client, tier: "low" as const }));
  return [...alternatives, ...primary];
}

export function aiProviderConfigured(coding: boolean): boolean {
  return createAIRoutes(coding).length > 0;
}

/** Resolve one authoritative automatic primary. Other providers require an explicit choice. */
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

  const main = runtimeRoute
    ? (coding && runtimeConfig?.agent_model ? createRuntimeAgentRoute(runtimeConfig) ?? runtimeRoute : runtimeRoute)
    : null;
  const primary: AIRouteTarget | null = main
    ? { ...main, providerId: `main-${main.kind}`, tier: "high" }
    : envTargets.find((target) => target.providerId === "glm") ?? null;
  const explicitAdminOverride = runtimeConfig?.source === "database";
  if (!preferFallback) {
    // A persisted Admin primary is intentional; absent that, no Groq/OSS or
    // managed account may silently replace a missing GLM configuration.
    return primary && (primary.provider === "GLM" || explicitAdminOverride) ? [primary] : [];
  }
  const alternatives = [...managedRouteTargets, ...createAIRoutes(coding, true, effectiveTier), ...envTargets]
    .filter((target) => !primary || `${target.provider}:${target.model}` !== `${primary.provider}:${primary.model}`);
  return [...alternatives, ...(primary ? [primary] : [])];
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
