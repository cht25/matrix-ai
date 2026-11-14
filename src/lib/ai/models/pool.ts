// The user's model pool: which registered models are really available on this
// deployment, and which of them the user has enabled.
//
// Availability is established from facts only:
//   configured  a server credential that can serve the model is installed
//   offered     the provider's live model catalog lists the model ID
// A model that fails either check is reported as unavailable with the reason,
// and is never enabled, scheduled, or shown as working.

import "server-only";
import { nowTs, type Db } from "@/lib/firebase/admin";
import { fetchModelCatalog } from "@/lib/ai/model-catalog";
import { MATRIX_MODEL_BASE_URL } from "@/lib/ai/model";
import { ensureAccounts } from "@/lib/ai/accounts";
import { hostedProviderKey, matrixModelRoute, routeForModel, type AIRouteTarget } from "@/lib/ai/config";
import { DEFAULT_MODEL_KEY, MODEL_REGISTRY, modelById, sanitizeModelKeys, type ModelSpec } from "@/lib/ai/models/registry";
import { cooldownRemainingMs } from "@/lib/ai/orchestrator/scheduler";
import type { ModelAvailability, ModelStatus, PoolPreference } from "@/lib/ai/models/types";

export type { ModelAvailability, ModelStatus, PoolPreference };

/** The most models that collaborate on a single request. */
export const MAX_ACTIVE_MODELS = 4;
const COLLECTION = "model_pools";

type Catalog = { ids: Map<string, number | undefined> } | { error: string } | null;

/** Live catalog for the hosted provider. null = no hosted credential. */
async function hostedCatalog(refresh = false): Promise<Catalog> {
  const key = hostedProviderKey();
  if (!key) return null;
  try {
    const result = await fetchModelCatalog({ baseUrl: MATRIX_MODEL_BASE_URL, apiKey: key, provider: "Groq", refresh });
    return { ids: new Map(result.models.map((model) => [model.id.toLowerCase(), model.contextTokens])) };
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 160) : "catalog request failed" };
  }
}

function availabilityOf(spec: ModelSpec, catalog: Catalog): { availability: ModelAvailability; contextTokens: number } {
  const isDefault = spec.key === DEFAULT_MODEL_KEY;
  const route = routeForModel(spec);
  if (!route) return { availability: "not_configured", contextTokens: spec.contextTokens };
  // The default model on a dedicated endpoint is not part of the hosted catalog.
  if (isDefault && route.providerId === "gpt-oss") return { availability: "available", contextTokens: spec.contextTokens };
  if (!catalog) return { availability: "not_configured", contextTokens: spec.contextTokens };
  if ("error" in catalog) {
    // The catalog could not be read. The default model keeps working exactly
    // as before (its own requests report real errors); nothing else is assumed.
    return { availability: isDefault ? "available" : "unverified", contextTokens: spec.contextTokens };
  }
  const id = spec.id.toLowerCase();
  if (!catalog.ids.has(id)) return { availability: "not_offered", contextTokens: spec.contextTokens };
  return { availability: "available", contextTokens: catalog.ids.get(id) ?? spec.contextTokens };
}

const REASON: Record<ModelAvailability, string> = {
  available: "Ready",
  not_configured: "No server credential is installed for this model.",
  not_offered: "The provider does not list this model for this account.",
  unverified: "The provider's model list could not be read, so this model is not used.",
};

/** Every registered model with its real, current status. No credentials. */
export async function listModelStatus(opts: { refresh?: boolean } = {}): Promise<ModelStatus[]> {
  const catalog = await hostedCatalog(opts.refresh);
  const dedicated = matrixModelRoute()?.providerId === "gpt-oss";
  return MODEL_REGISTRY.map((spec) => {
    const { availability, contextTokens } = availabilityOf(spec, catalog);
    const cooling = cooldownRemainingMs(spec.key);
    return {
      key: spec.key,
      label: spec.label,
      summary: spec.summary,
      model_id: spec.id,
      provider: spec.key === DEFAULT_MODEL_KEY && dedicated ? "Dedicated endpoint" : spec.providerLabel,
      availability,
      reason: availability === "available" && cooling > 0 ? `Rate-limited by the provider; resumes in about ${Math.ceil(cooling / 1000)}s.` : REASON[availability],
      is_default: spec.key === DEFAULT_MODEL_KEY,
      strengths: [...spec.strengths],
      context_tokens: contextTokens,
      max_output_tokens: spec.maxOutputTokens,
      streaming: spec.streaming,
      tool_calling: spec.toolCalling,
      structured_output: spec.structuredOutput,
    };
  });
}

export async function getPoolPreference(d: Db, uid: string): Promise<PoolPreference> {
  try {
    const snap = await d.collection(COLLECTION).doc(uid).get();
    const data = snap.exists ? snap.data()! : null;
    if (!data) return { auto: true, enabled: [] };
    const enabled = sanitizeModelKeys(data.enabled);
    return { auto: data.auto !== false || enabled.length === 0, enabled };
  } catch {
    return { auto: true, enabled: [] };
  }
}

export async function setPoolPreference(d: Db, uid: string, input: { auto: boolean; enabled: unknown }): Promise<PoolPreference> {
  const enabled = sanitizeModelKeys(input.enabled).slice(0, MAX_ACTIVE_MODELS);
  if (!input.auto && enabled.length === 0) throw new Error("EMPTY_MODEL_POOL");
  // Only models that are really available can be enabled.
  const available = new Set((await listModelStatus()).filter((model) => model.availability === "available").map((model) => model.key));
  const usable = enabled.filter((key) => available.has(key));
  if (!input.auto && usable.length === 0) throw new Error("MODEL_UNAVAILABLE");
  const preference: PoolPreference = { auto: input.auto, enabled: usable };
  await d.collection(COLLECTION).doc(uid).set({ ...preference, updated_at: nowTs() }, { merge: true });
  return preference;
}

export type ResolvedPool = {
  /** Executable routes, coordinator first. Empty when nothing is configured. */
  targets: AIRouteTarget[];
  auto: boolean;
  /** Enabled models that were skipped because they are not available now. */
  skipped: { key: string; label: string; reason: string }[];
};

function rank(target: AIRouteTarget): number {
  return modelById(target.model)?.coordinatorRank ?? 99;
}

/**
 * The models that may work on a request for this user, strongest coordinator
 * first. `override` is a per-request selection (still filtered to models that
 * are available — a client can never force an unavailable model).
 */
export async function resolvePool(d: Db | null, uid: string | null, override?: { auto?: boolean; enabled?: unknown } | null): Promise<ResolvedPool> {
  await ensureAccounts(d);
  const statuses = await listModelStatus();
  const preference: PoolPreference = override && (override.auto !== undefined || override.enabled !== undefined)
    ? { auto: override.auto === true || sanitizeModelKeys(override.enabled).length === 0, enabled: sanitizeModelKeys(override.enabled) }
    : d && uid ? await getPoolPreference(d, uid) : { auto: true, enabled: [] };
  const wanted = preference.auto ? statuses.map((model) => model.key) : preference.enabled;
  const targets: AIRouteTarget[] = [];
  const skipped: ResolvedPool["skipped"] = [];
  for (const key of wanted) {
    const status = statuses.find((model) => model.key === key);
    const spec = MODEL_REGISTRY.find((model) => model.key === key);
    if (!status || !spec) continue;
    const route = status.availability === "available" ? routeForModel(spec) : null;
    if (!route) {
      if (!preference.auto) skipped.push({ key, label: spec.label, reason: status.reason });
      continue;
    }
    targets.push({ ...route, contextTokens: status.context_tokens });
  }
  targets.sort((a, b) => rank(a) - rank(b));
  // If none of the user's chosen models can run, continue with the default
  // model rather than failing the request — and say so via `skipped`.
  if (!targets.length && !preference.auto) {
    const fallback = matrixModelRoute();
    if (fallback) targets.push(fallback);
  }
  return { targets: targets.slice(0, MAX_ACTIVE_MODELS), auto: preference.auto, skipped };
}
