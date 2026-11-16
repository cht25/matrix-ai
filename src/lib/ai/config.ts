// Server-side AI configuration.
//
// QORVYNA runs a pool of collaborating models (see `@/lib/ai/models/registry`).
// GPT OSS 120B is the default; additional models are used only when the
// provider's live catalog confirms they are offered to this deployment and
// the user has them enabled (see `@/lib/ai/models/pool`). This module turns a
// model plus the server-side credential into an executable route. Credentials
// never leave the server.

import "server-only";

import type { Db } from "@/lib/firebase/admin";
import { GroqProvider, type AIProvider } from "@/lib/ai/groq";
import { createOpenAICompatibleProvider } from "@/lib/ai/openai";
import { CloudflareProvider, cloudflareCredentials, cloudflareConfigured } from "@/lib/ai/cloudflare";
import type { WorkloadTier } from "@/lib/ai/router";
import type { AIProviderName } from "@/lib/ai/provider-error";
import {
  QORVYNA_MODEL_BASE_URL,
  QORVYNA_MODEL_ID,
  QORVYNA_MODEL_LABEL,
  QORVYNA_MODEL_PROVIDER,
  QORVYNA_MODEL_PROVIDER_ID,
  dedicatedEndpointModelId,
  isQorvynaModelId,
} from "@/lib/ai/model";
import { DEFAULT_MODEL_KEY, modelLabel, type ModelSpec } from "@/lib/ai/models/registry";
import { ensureAccounts, listAccounts } from "@/lib/ai/accounts";

export type AIRouteTarget = {
  provider: AIProviderName;
  model: string;
  client: AIProvider;
  providerId?: string;
  tier?: WorkloadTier;
  contextTokens?: number;
};

/** Displayed defaults. Every role is the same model. */
export const AI_CONFIG = {
  general: { provider: QORVYNA_MODEL_PROVIDER, model: QORVYNA_MODEL_ID },
  coding: { provider: QORVYNA_MODEL_PROVIDER, model: QORVYNA_MODEL_ID },
} as const;

function secret(value: string | undefined): string {
  const key = value?.trim() ?? "";
  return key && !key.endsWith("...") && !key.includes("...") && !key.startsWith("YOUR-") && !key.startsWith("replace-with") ? key : "";
}

export type QorvynaModelStatus = {
  configured: boolean;
  provider: string;
  provider_id: string;
  model: string;
  label: string;
  /** Which server credential is in use. Never the credential itself. */
  credential: "GROQ_API_KEY" | "GPT_OSS_API_KEY" | "CLOUDFLARE_API_TOKEN" | "none";
  endpoint: string;
};

/**
 * Cloudflare Workers AI route — null unless BOTH backend environment
 * variables are installed (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN).
 * The token never leaves this server.
 */
export function cloudflareRoute(): AIRouteTarget | null {
  const credentials = cloudflareCredentials();
  if (!credentials) return null;
  return {
    provider: "Cloudflare",
    providerId: "cloudflare",
    model: credentials.model,
    client: new CloudflareProvider(credentials),
    tier: "high",
  };
}

/**
 * The Groq / dedicated-endpoint route (existing providers, unchanged).
 *
 *   GROQ_API_KEY                       → Groq, QORVYNA_MODEL_ID          (default)
 *   GPT_OSS_API_KEY + GPT_OSS_BASE_URL → the same model on a dedicated
 *                                        OpenAI-compatible endpoint
 */
function hostedRoute(): AIRouteTarget | null {
  const dedicatedKey = secret(process.env.GPT_OSS_API_KEY);
  const dedicatedBase = process.env.GPT_OSS_BASE_URL?.trim() ?? "";
  if (dedicatedKey && dedicatedBase) {
    const model = dedicatedEndpointModelId(process.env.GPT_OSS_MODEL);
    return {
      provider: "OpenAI",
      providerId: "gpt-oss",
      model,
      client: createOpenAICompatibleProvider({ apiKey: dedicatedKey, baseUrl: dedicatedBase, label: QORVYNA_MODEL_LABEL, model }),
      tier: "high",
    };
  }
  const groqKey = hostedProviderKey() || dedicatedKey;
  if (!groqKey) return null;
  return {
    provider: QORVYNA_MODEL_PROVIDER,
    providerId: QORVYNA_MODEL_PROVIDER_ID,
    model: QORVYNA_MODEL_ID,
    client: new GroqProvider(groqKey, { pooled: true }),
    tier: "high",
  };
}

/** Every configured route, primary first. Empty when nothing is installed. */
function configuredRoutes(): AIRouteTarget[] {
  const primary = cloudflareRoute() ?? hostedRoute();
  if (!primary) return [];
  const routes = [primary];
  const hosted = hostedRoute();
  if (hosted && !(primary.providerId === hosted.providerId && primary.model === hosted.model)) routes.push(hosted);
  return routes;
}

/**
 * The PRIMARY executable route, or null when no credential is installed.
 * Cloudflare Workers AI leads when it is configured; otherwise this is the
 * existing Groq / dedicated-endpoint route exactly as before.
 */
export function qorvynaModelRoute(): AIRouteTarget | null {
  return configuredRoutes()[0] ?? null;
}

/** Server credential for the hosted provider, or "" when none is installed. */
export function hostedProviderKey(): string {
  // The first connected account: the environment key when there is one,
  // otherwise an account the administrator registered.
  return listAccounts().find((account) => account.enabled)?.key ?? "";
}

/**
 * Executable route for one registered model, or null when this deployment has
 * no credential that can serve it. Cloudflare specs need the Cloudflare
 * credential; the default model is served by the hosted provider (or the
 * dedicated endpoint); every other model needs the hosted provider key.
 */
export function routeForModel(spec: ModelSpec): AIRouteTarget | null {
  if (spec.provider === "cloudflare") return cloudflareRoute();
  if (spec.key === DEFAULT_MODEL_KEY) return hostedRoute();
  const key = hostedProviderKey();
  if (!key) return null;
  return { provider: QORVYNA_MODEL_PROVIDER, providerId: QORVYNA_MODEL_PROVIDER_ID, model: spec.id, client: new GroqProvider(key, { pooled: true }), tier: "high", contextTokens: spec.contextTokens };
}

export function qorvynaModelStatus(): QorvynaModelStatus {
  const primary = qorvynaModelRoute();
  if (primary?.providerId === "cloudflare") {
    return {
      configured: true,
      provider: "Cloudflare Workers AI",
      provider_id: "cloudflare",
      model: primary.model,
      label: modelLabel(primary.model),
      credential: "CLOUDFLARE_API_TOKEN",
      endpoint: "https://api.cloudflare.com/client/v4",
    };
  }
  const route = primary;
  const dedicated = route?.providerId === "gpt-oss";
  return {
    configured: Boolean(route),
    provider: dedicated ? "Dedicated GPT OSS endpoint" : QORVYNA_MODEL_PROVIDER,
    provider_id: route?.providerId ?? QORVYNA_MODEL_PROVIDER_ID,
    model: route?.model ?? QORVYNA_MODEL_ID,
    label: QORVYNA_MODEL_LABEL,
    credential: !route ? "none" : dedicated ? "GPT_OSS_API_KEY" : secret(process.env.GROQ_API_KEY) ? "GROQ_API_KEY" : "GPT_OSS_API_KEY",
    endpoint: dedicated ? "dedicated" : QORVYNA_MODEL_BASE_URL,
  };
}

const CONFIG_LOGGED = "__matrixAiConfigurationLogged";

export function logAIConfiguration(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[CONFIG_LOGGED]) return;
  globalState[CONFIG_LOGGED] = true;
  const status = qorvynaModelStatus();
  console.info("[QORVYNA] AI configuration", {
    architecture: "collaborative model pool — Cloudflare Workers AI when configured, then GPT OSS 120B; other models only when the provider catalog lists them",
    provider: status.provider,
    model: status.model,
    credential: status.configured ? "configured" : "missing",
    cloudflare: cloudflareConfigured() ? "configured" : "not-configured",
    fallback: configuredRoutes().length > 1 ? "enabled" : "single-provider",
  });
  // These legacy variables never select a model — say so once.
  for (const name of ["GROQ_CHAT_MODEL", "GROQ_CODING_MODEL", "GROQ_FAST_MODEL", "GPT_OSS_MODEL"] as const) {
    const value = process.env[name]?.trim();
    if (value && !isQorvynaModelId(value)) {
      console.warn(`[QORVYNA] ${name} is set to a different model and is ignored: models are chosen from the registry (default ${QORVYNA_MODEL_ID}).`);
    }
  }
}

/**
 * Executable routes, PRIMARY FIRST, then every other configured provider as
 * automatic fallback (Cloudflare → Groq/dedicated when both are installed).
 * The user's pool is resolved in models/pool.ts; these are the gateway
 * defaults for call sites that do not take a per-user pool.
 */
export function createAIRoutes(_coding = false): AIRouteTarget[] {
  void _coding;
  return configuredRoutes();
}

export function aiProviderConfigured(_coding = false): boolean {
  void _coding;
  return qorvynaModelRoute() !== null;
}

/**
 * Async form kept for call sites that used to consult the database. Chat,
 * Agent, Code, Research, orchestrator and comparison turns all receive the
 * same single route; the mode only changes instructions and tools.
 */
export async function createAIRoutesFromDb(d?: Db | null, _coding = false): Promise<AIRouteTarget[]> {
  void _coding;
  await ensureAccounts(d);
  return createAIRoutes();
}

/** The Agent/build pipeline's route. Identical to Chat's. */
export async function resolveExecutionRoutes(d?: Db | null): Promise<{ routes: AIRouteTarget[] }> {
  await ensureAccounts(d);
  return { routes: createAIRoutes() };
}

/**
 * Image understanding. GPT OSS 120B is a text model, and QORVYNA does not route
 * to any other model, so there is no vision route. Callers report
 * `VISION_NOT_SUPPORTED` instead of sending an image to a model that cannot
 * read it.
 */
export const VISION_SUPPORTED = false;

export class AIConfigurationError extends Error {
  constructor(public readonly coding: boolean = false) {
    super(`${QORVYNA_MODEL_LABEL} is not configured on this server`);
    this.name = "AIConfigurationError";
  }
}
