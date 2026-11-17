// The user's model pool: which registered models are really available on this
// deployment, and which of them the user has enabled.
//
// Availability is established from facts only:
//   configured  a server credential that can serve the model is installed
//   offered     the provider's live model catalog lists the model ID (or a
//               direct connectivity probe succeeded)
// Temporary discovery errors are NEVER cached as permanent unavailability.

import "server-only";
import { nowTs, type Db } from "@/lib/firebase/admin";
import { fetchModelCatalog } from "@/lib/ai/model-catalog";
import { QORVYNA_MODEL_BASE_URL } from "@/lib/ai/model";
import { ensureAccounts } from "@/lib/ai/accounts";
import {
  cloudflareConfigured,
  cloudflareCredentials,
  probeCloudflareCatalog,
} from "@/lib/ai/cloudflare";
import { hostedProviderKey, qorvynaModelRoute, routeForModel, type AIRouteTarget } from "@/lib/ai/config";
import {
  CLOUDFLARE_MODEL_KEY,
  DEFAULT_MODEL_KEY,
  MODEL_REGISTRY,
  defaultModel,
  modelById,
  sanitizeModelKeys,
  type ModelSpec,
} from "@/lib/ai/models/registry";
import { cooldownRemainingMs } from "@/lib/ai/orchestrator/scheduler";
import {
  PROBE_STATE_LABEL,
  type ModelAvailability,
  type ModelDiagnosticError,
  type ModelProbeState,
  type ModelStatus,
  type PoolPreference,
} from "@/lib/ai/models/types";

export type { ModelAvailability, ModelDiagnosticError, ModelProbeState, ModelStatus, PoolPreference };

/** The most models that collaborate on a single request. */
export const MAX_ACTIVE_MODELS = 4;
const COLLECTION = "model_pools";

type Catalog = { ids: Map<string, number | undefined> } | { error: string; state: ModelProbeState } | null;
type IdCatalog =
  | { ids: Set<string> }
  | { error: string; state: ModelProbeState; status: number | null; code: string }
  | null;

type RuntimeModelHealth = {
  lastTestedAt: string | null;
  lastTestedOk: boolean | null;
  lastState: ModelProbeState | null;
  lastError: ModelDiagnosticError | null;
};

const runtimeHealth = new Map<string, RuntimeModelHealth>();

export function recordModelProbeResult(
  modelKey: string,
  result: {
    ok: boolean;
    state: ModelProbeState;
    code: string;
    message: string;
    status: number | null;
    at?: string;
  },
): void {
  const at = result.at ?? new Date().toISOString();
  const prev = runtimeHealth.get(modelKey);
  runtimeHealth.set(modelKey, {
    lastTestedAt: result.ok ? at : prev?.lastTestedAt ?? null,
    lastTestedOk: result.ok,
    lastState: result.state,
    lastError: result.ok
      ? null
      : { code: result.code, message: result.message, status: result.status, at },
  });
}

export function resetModelHealthForTests(): void {
  runtimeHealth.clear();
  cloudflareCatalogCache = null;
}

/** Live catalog for the hosted provider. null = no hosted credential. */
async function hostedCatalog(refresh = false): Promise<Catalog> {
  const key = hostedProviderKey();
  if (!key) return null;
  try {
    const result = await fetchModelCatalog({ baseUrl: QORVYNA_MODEL_BASE_URL, apiKey: key, provider: "Groq", refresh });
    return { ids: new Map(result.models.map((model) => [model.id.toLowerCase(), model.contextTokens])) };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : "catalog request failed";
    const lower = message.toLowerCase();
    const state: ModelProbeState = /401|auth/.test(lower)
      ? "invalid_credentials"
      : /403|permission/.test(lower)
        ? "permission_denied"
        : /429|rate/.test(lower)
          ? "rate_limited"
          : "temporarily_unavailable";
    return { error: message, state };
  }
}

const CLOUDFLARE_CATALOG_TTL_MS = 5 * 60_000;
let cloudflareCatalogCache: { at: number; accountId: string; ids: Set<string> } | null = null;

/**
 * Live model list for this Cloudflare account (GET /ai/models/search).
 * null = Cloudflare is not configured.
 * Temporary lookup errors are NEVER cached as permanent unavailability.
 */
async function cloudflareCatalog(refresh = false): Promise<IdCatalog> {
  if (!cloudflareConfigured()) {
    cloudflareCatalogCache = null;
    return null;
  }
  const credentials = cloudflareCredentials();
  if (!credentials) {
    cloudflareCatalogCache = null;
    return null;
  }
  if (
    !refresh &&
    cloudflareCatalogCache &&
    cloudflareCatalogCache.accountId === credentials.accountId &&
    Date.now() - cloudflareCatalogCache.at < CLOUDFLARE_CATALOG_TTL_MS
  ) {
    return { ids: cloudflareCatalogCache.ids };
  }

  const probe = await probeCloudflareCatalog(credentials);
  if (probe.ok) {
    const ids = new Set(probe.models.map((model) => model.id.toLowerCase()));
    cloudflareCatalogCache = { at: Date.now(), accountId: credentials.accountId, ids };
    return { ids };
  }

  // Do NOT poison `cloudflareCatalogCache` on failures — next check or refresh
  // immediately retries Cloudflare cleanly.
  return { error: probe.message, state: probe.state, status: probe.status, code: probe.code };
}

function diagnosticHintFor(state: ModelProbeState, spec: ModelSpec): string | null {
  switch (state) {
    case "configuration_missing":
      return spec.provider === "cloudflare"
        ? "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN on the server."
        : "Set GROQ_API_KEY (or dedicated endpoint credentials) on the server.";
    case "invalid_credentials":
      return spec.provider === "cloudflare"
        ? "Verify CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Cloudflare Profile → API Tokens."
        : "Verify the provider API key on the server.";
    case "permission_denied":
      return "Ensure the Cloudflare API token has Workers AI Read and Workers AI Edit permissions.";
    case "model_not_found":
      return `Confirm the catalog model identifier (${spec.id}) is enabled on this account.`;
    case "out_of_capacity":
      return "Daily free quota or model capacity reached. Wait for reset (00:00 UTC) or retry shortly.";
    case "rate_limited":
      return "Provider rate limit active. Retry in a few moments.";
    case "temporarily_unavailable":
      return "Temporary upstream/network issue. Press Refresh status or Test connection to retry.";
    case "unavailable_for_account":
      return "This account's model catalog did not include this model. Check Cloudflare account access or token permissions.";
    default:
      return null;
  }
}

type AvailabilityEvaluation = {
  availability: ModelAvailability;
  contextTokens: number;
  statusCode: ModelProbeState;
  statusLabel: string;
  reason: string;
  lastTestedAt: string | null;
  lastError: ModelDiagnosticError | null;
  diagnosticHint: string | null;
};

function availabilityOf(spec: ModelSpec, catalog: Catalog, cfCatalog: IdCatalog): AvailabilityEvaluation {
  const isDefault = spec.key === DEFAULT_MODEL_KEY;
  const health = runtimeHealth.get(spec.key);
  const route = routeForModel(spec);
  if (!route) {
    return {
      availability: "not_configured",
      contextTokens: spec.contextTokens,
      statusCode: "configuration_missing",
      statusLabel: PROBE_STATE_LABEL.configuration_missing,
      reason: REASON.not_configured,
      lastTestedAt: health?.lastTestedAt ?? null,
      lastError: health?.lastError ?? null,
      diagnosticHint: diagnosticHintFor("configuration_missing", spec),
    };
  }

  // Cloudflare specs are verified against the account's own model list —
  // never against the Groq catalog, and never assumed.
  if (spec.provider === "cloudflare") {
    if (!cfCatalog) {
      return {
        availability: "not_configured",
        contextTokens: spec.contextTokens,
        statusCode: "configuration_missing",
        statusLabel: PROBE_STATE_LABEL.configuration_missing,
        reason: REASON.not_configured,
        lastTestedAt: health?.lastTestedAt ?? null,
        lastError: health?.lastError ?? null,
        diagnosticHint: diagnosticHintFor("configuration_missing", spec),
      };
    }
    if ("error" in cfCatalog) {
      // If a direct inference test (`POST /api/models/test`) recently succeeded,
      // honour that verified result when only catalog listing failed due to
      // missing Read scope (403). Never claim Ready on 401 invalid credentials!
      if (cfCatalog.state === "permission_denied" && health?.lastTestedOk) {
        return {
          availability: "available",
          contextTokens: spec.contextTokens,
          statusCode: "available",
          statusLabel: PROBE_STATE_LABEL.available,
          reason: "Verified via direct inference test (catalog read requires Workers AI Read permission).",
          lastTestedAt: health.lastTestedAt,
          lastError: null,
          diagnosticHint: diagnosticHintFor("permission_denied", spec),
        };
      }
      const catalogError: ModelDiagnosticError = {
        code: cfCatalog.code,
        message: cfCatalog.error,
        status: cfCatalog.status,
        at: new Date().toISOString(),
      };
      return {
        availability: "unverified",
        contextTokens: spec.contextTokens,
        statusCode: cfCatalog.state,
        statusLabel: PROBE_STATE_LABEL[cfCatalog.state] ?? PROBE_STATE_LABEL.temporarily_unavailable,
        reason: cfCatalog.error,
        lastTestedAt: health?.lastTestedAt ?? null,
        lastError: health?.lastError ?? catalogError,
        diagnosticHint: diagnosticHintFor(cfCatalog.state, spec),
      };
    }

    if (!cfCatalog.ids.has(spec.id.toLowerCase())) {
      // If a direct inference probe succeeded (e.g. account can run model even
      // if search omitted it), report available; otherwise unavailable_for_account.
      if (health?.lastTestedOk) {
        return {
          availability: "available",
          contextTokens: spec.contextTokens,
          statusCode: "available",
          statusLabel: PROBE_STATE_LABEL.available,
          reason: "Ready (verified via direct connectivity test).",
          lastTestedAt: health.lastTestedAt,
          lastError: null,
          diagnosticHint: null,
        };
      }
      return {
        availability: "not_offered",
        contextTokens: spec.contextTokens,
        statusCode: "unavailable_for_account",
        statusLabel: PROBE_STATE_LABEL.unavailable_for_account,
        reason: "This Cloudflare account's model catalog did not include this model.",
        lastTestedAt: health?.lastTestedAt ?? null,
        lastError: health?.lastError ?? null,
        diagnosticHint: diagnosticHintFor("unavailable_for_account", spec),
      };
    }

    // Listed in Cloudflare catalog — also check if the most recent direct
    // connectivity test explicitly failed (e.g. quota, invalid creds, 503).
    if (health?.lastTestedOk === false && health.lastState && health.lastError) {
      return {
        availability: health.lastState === "model_not_found" ? "not_offered" : "available",
        contextTokens: spec.contextTokens,
        statusCode: health.lastState,
        statusLabel: PROBE_STATE_LABEL[health.lastState],
        reason: health.lastError.message,
        lastTestedAt: health.lastTestedAt,
        lastError: health.lastError,
        diagnosticHint: diagnosticHintFor(health.lastState, spec),
      };
    }

    return {
      availability: "available",
      contextTokens: spec.contextTokens,
      statusCode: "available",
      statusLabel: PROBE_STATE_LABEL.available,
      reason: REASON.available,
      lastTestedAt: health?.lastTestedAt ?? null,
      lastError: health?.lastError ?? null,
      diagnosticHint: null,
    };
  }

  // The default model on a dedicated endpoint is not part of the hosted catalog.
  if (isDefault && route.providerId === "gpt-oss") {
    return {
      availability: "available",
      contextTokens: spec.contextTokens,
      statusCode: "available",
      statusLabel: PROBE_STATE_LABEL.available,
      reason: REASON.available,
      lastTestedAt: health?.lastTestedAt ?? null,
      lastError: health?.lastError ?? null,
      diagnosticHint: null,
    };
  }
  if (!catalog) {
    return {
      availability: "not_configured",
      contextTokens: spec.contextTokens,
      statusCode: "configuration_missing",
      statusLabel: PROBE_STATE_LABEL.configuration_missing,
      reason: REASON.not_configured,
      lastTestedAt: health?.lastTestedAt ?? null,
      lastError: health?.lastError ?? null,
      diagnosticHint: diagnosticHintFor("configuration_missing", spec),
    };
  }
  if ("error" in catalog) {
    // The catalog could not be read. The default model keeps working; nothing else is assumed.
    const avail: ModelAvailability = isDefault ? "available" : "unverified";
    const statusCode: ModelProbeState = isDefault ? "available" : catalog.state;
    return {
      availability: avail,
      contextTokens: spec.contextTokens,
      statusCode,
      statusLabel: PROBE_STATE_LABEL[statusCode],
      reason: isDefault ? REASON.available : catalog.error || REASON.unverified,
      lastTestedAt: health?.lastTestedAt ?? null,
      lastError: isDefault ? health?.lastError ?? null : { code: catalog.state.toUpperCase(), message: catalog.error, status: null, at: new Date().toISOString() },
      diagnosticHint: isDefault ? null : diagnosticHintFor(catalog.state, spec),
    };
  }
  const id = spec.id.toLowerCase();
  if (!catalog.ids.has(id)) {
    return {
      availability: "not_offered",
      contextTokens: spec.contextTokens,
      statusCode: "unavailable_for_account",
      statusLabel: PROBE_STATE_LABEL.unavailable_for_account,
      reason: REASON.not_offered,
      lastTestedAt: health?.lastTestedAt ?? null,
      lastError: health?.lastError ?? null,
      diagnosticHint: diagnosticHintFor("unavailable_for_account", spec),
    };
  }
  return {
    availability: "available",
    contextTokens: catalog.ids.get(id) ?? spec.contextTokens,
    statusCode: "available",
    statusLabel: PROBE_STATE_LABEL.available,
    reason: REASON.available,
    lastTestedAt: health?.lastTestedAt ?? null,
    lastError: health?.lastError ?? null,
    diagnosticHint: null,
  };
}

const REASON: Record<ModelAvailability, string> = {
  available: "Ready",
  not_configured: "No server credential is installed for this model.",
  not_offered: "The provider does not list this model for this account.",
  unverified: "The provider's model list could not be read, so this model is not used.",
};

/** Every registered model with its real, current status. No credentials. */
export async function listModelStatus(opts: { refresh?: boolean } = {}): Promise<ModelStatus[]> {
  const [catalog, cfCatalog] = await Promise.all([hostedCatalog(opts.refresh), cloudflareCatalog(opts.refresh)]);
  // "Dedicated" describes the HOSTED route for the default model, so it must
  // not be inferred from the primary route (which may be Cloudflare).
  const dedicated = routeForModel(defaultModel())?.providerId === "gpt-oss";
  return MODEL_REGISTRY.map((spec) => {
    const evalResult = availabilityOf(spec, catalog, cfCatalog);
    const cooling = cooldownRemainingMs(spec.key);
    const rateLimited = evalResult.availability === "available" && cooling > 0;
    const statusCode: ModelProbeState = rateLimited ? "rate_limited" : evalResult.statusCode;
    return {
      key: spec.key,
      label: spec.label,
      summary: spec.summary,
      model_id: spec.id,
      provider: spec.key === DEFAULT_MODEL_KEY && dedicated ? "Dedicated endpoint" : spec.providerLabel,
      availability: evalResult.availability,
      reason: rateLimited
        ? `Rate-limited by the provider; resumes in about ${Math.ceil(cooling / 1000)}s.`
        : evalResult.reason,
      is_default: spec.key === DEFAULT_MODEL_KEY,
      strengths: [...spec.strengths],
      context_tokens: evalResult.contextTokens,
      max_output_tokens: spec.maxOutputTokens,
      streaming: spec.streaming,
      tool_calling: spec.toolCalling,
      structured_output: spec.structuredOutput,
      status_code: statusCode,
      status_label: PROBE_STATE_LABEL[statusCode],
      supported_modes: [...spec.supportedModes],
      last_tested_at: evalResult.lastTestedAt,
      last_error: evalResult.lastError,
      diagnostic_hint: evalResult.diagnosticHint,
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
  // Never silently substitute GPT OSS when the user explicitly locked only
  // Cloudflare GLM (`auto: false`, `enabled: ["glm-4.7-flash"]`). For other
  // unavailable models in a manual pool, fall back to the default route and
  // report `skipped` transparently.
  const explicitGlmOnly =
    !preference.auto &&
    preference.enabled.length === 1 &&
    preference.enabled[0] === CLOUDFLARE_MODEL_KEY;
  if (!targets.length && !preference.auto && !explicitGlmOnly) {
    const fallback = qorvynaModelRoute();
    if (fallback) targets.push(fallback);
  }
  return { targets: targets.slice(0, MAX_ACTIVE_MODELS), auto: preference.auto, skipped };
}
