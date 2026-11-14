// Server-side AI configuration.
//
// ONE PLATFORM, ONE MODEL: every AI request in MATRIX is executed by GPT OSS
// 120B (see `@/lib/ai/model`). This module turns that single identifier plus
// the server-side credential into the one executable route. There is no
// provider registry, no ranking, no per-user or per-mode model and no
// fallback: when the model is unavailable the request fails with a clear
// provider error and the user can retry.

import "server-only";

import type { Db } from "@/lib/firebase/admin";
import { GroqProvider, type AIProvider } from "@/lib/ai/groq";
import { createOpenAICompatibleProvider } from "@/lib/ai/openai";
import type { WorkloadTier } from "@/lib/ai/router";
import type { AIProviderName } from "@/lib/ai/provider-error";
import {
  MATRIX_MODEL_BASE_URL,
  MATRIX_MODEL_ID,
  MATRIX_MODEL_LABEL,
  MATRIX_MODEL_PROVIDER,
  MATRIX_MODEL_PROVIDER_ID,
  dedicatedEndpointModelId,
  isMatrixModelId,
} from "@/lib/ai/model";

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
  general: { provider: MATRIX_MODEL_PROVIDER, model: MATRIX_MODEL_ID },
  coding: { provider: MATRIX_MODEL_PROVIDER, model: MATRIX_MODEL_ID },
} as const;

function secret(value: string | undefined): string {
  const key = value?.trim() ?? "";
  return key && !key.endsWith("...") && !key.includes("...") && !key.startsWith("YOUR-") && !key.startsWith("replace-with") ? key : "";
}

export type MatrixModelStatus = {
  configured: boolean;
  provider: string;
  provider_id: string;
  model: string;
  label: string;
  /** Which server credential is in use. Never the credential itself. */
  credential: "GROQ_API_KEY" | "GPT_OSS_API_KEY" | "none";
  endpoint: string;
};

/**
 * The one executable route, or null when no credential is installed.
 *
 *   GROQ_API_KEY                       → Groq, MATRIX_MODEL_ID          (default)
 *   GPT_OSS_API_KEY + GPT_OSS_BASE_URL → the same model on a dedicated
 *                                        OpenAI-compatible endpoint
 *
 * Both serve GPT OSS 120B. Exactly one is active per deployment; the second
 * is never a fallback for the first.
 */
export function matrixModelRoute(): AIRouteTarget | null {
  const dedicatedKey = secret(process.env.GPT_OSS_API_KEY);
  const dedicatedBase = process.env.GPT_OSS_BASE_URL?.trim() ?? "";
  if (dedicatedKey && dedicatedBase) {
    const model = dedicatedEndpointModelId(process.env.GPT_OSS_MODEL);
    return {
      provider: "OpenAI",
      providerId: "gpt-oss",
      model,
      client: createOpenAICompatibleProvider({ apiKey: dedicatedKey, baseUrl: dedicatedBase, label: MATRIX_MODEL_LABEL, model }),
      tier: "high",
    };
  }
  const groqKey = secret(process.env.GROQ_API_KEY) || dedicatedKey;
  if (!groqKey) return null;
  return {
    provider: MATRIX_MODEL_PROVIDER,
    providerId: MATRIX_MODEL_PROVIDER_ID,
    model: MATRIX_MODEL_ID,
    client: new GroqProvider(groqKey),
    tier: "high",
  };
}

export function matrixModelStatus(): MatrixModelStatus {
  const route = matrixModelRoute();
  const dedicated = route?.providerId === "gpt-oss";
  return {
    configured: Boolean(route),
    provider: dedicated ? "Dedicated GPT OSS endpoint" : MATRIX_MODEL_PROVIDER,
    provider_id: route?.providerId ?? MATRIX_MODEL_PROVIDER_ID,
    model: route?.model ?? MATRIX_MODEL_ID,
    label: MATRIX_MODEL_LABEL,
    credential: !route ? "none" : dedicated ? "GPT_OSS_API_KEY" : secret(process.env.GROQ_API_KEY) ? "GROQ_API_KEY" : "GPT_OSS_API_KEY",
    endpoint: dedicated ? "dedicated" : MATRIX_MODEL_BASE_URL,
  };
}

const CONFIG_LOGGED = "__matrixAiConfigurationLogged";

export function logAIConfiguration(): void {
  const globalState = globalThis as Record<string, unknown>;
  if (globalState[CONFIG_LOGGED]) return;
  globalState[CONFIG_LOGGED] = true;
  const status = matrixModelStatus();
  console.info("[MATRIX] AI configuration", {
    architecture: "single model — GPT OSS 120B for Chat, Agent and every AI feature; no fallback model",
    provider: status.provider,
    model: status.model,
    credential: status.configured ? "configured" : "missing",
  });
  // A leftover override must not silently change the model — say so once.
  for (const name of ["GROQ_CHAT_MODEL", "GROQ_CODING_MODEL", "GROQ_FAST_MODEL", "GPT_OSS_MODEL"] as const) {
    const value = process.env[name]?.trim();
    if (value && !isMatrixModelId(value)) {
      console.warn(`[MATRIX] ${name} is set to a different model and is ignored: MATRIX only runs ${MATRIX_MODEL_ID}.`);
    }
  }
}

/** The route list for any workload. Always zero or one entry: GPT OSS 120B. */
export function createAIRoutes(_coding = false): AIRouteTarget[] {
  void _coding;
  const route = matrixModelRoute();
  return route ? [route] : [];
}

export function aiProviderConfigured(_coding = false): boolean {
  void _coding;
  return matrixModelRoute() !== null;
}

/**
 * Async form kept for call sites that used to consult the database. Chat,
 * Agent, Code, Research, orchestrator and comparison turns all receive the
 * same single route; the mode only changes instructions and tools.
 */
export async function createAIRoutesFromDb(_d?: Db | null, _coding = false): Promise<AIRouteTarget[]> {
  void _d; void _coding;
  return createAIRoutes();
}

/** The Agent/build pipeline's route. Identical to Chat's. */
export async function resolveExecutionRoutes(_d?: Db | null): Promise<{ routes: AIRouteTarget[] }> {
  void _d;
  return { routes: createAIRoutes() };
}

/**
 * Image understanding. GPT OSS 120B is a text model, and MATRIX does not route
 * to any other model, so there is no vision route. Callers report
 * `VISION_NOT_SUPPORTED` instead of sending an image to a model that cannot
 * read it.
 */
export const VISION_SUPPORTED = false;

export class AIConfigurationError extends Error {
  constructor(public readonly coding: boolean = false) {
    super(`${MATRIX_MODEL_LABEL} is not configured on this server`);
    this.name = "AIConfigurationError";
  }
}
