// =============================================================================
// Cloudflare Workers AI — free-quota accounting (server-side only).
//
// Free plan: 10,000 Neurons per day, resetting at 00:00 UTC. This module:
//   • tracks actual usage — Cloudflare's GraphQL analytics when the token may
//     read it, otherwise neuron counts the API itself reported on a response;
//     it NEVER estimates neurons from token counts. When neither is
//     available it says so (`neurons_source: "unavailable"`) and falls back to
//     a configurable REQUEST budget as the safety reserve;
//   • gates every outgoing request BEFORE it is sent: an exhausted day throws
//     a typed, fallback-eligible provider error instead of burning a call;
//   • never enables paid billing, never changes the plan, never clears the
//     user's conversation — exhaustion only stops THIS provider, so the
//     gateway continues on an already-configured provider;
//   • stores counters in Firestore (`cloudflare_usage/<YYYY-MM-DD>`), never
//     in localStorage, with an in-process fallback when Firestore is down;
//   • never logs the API token.
// =============================================================================

import "server-only";

import { adminConfigured, adminDb } from "@/lib/firebase/admin";
import { AIProviderError } from "@/lib/ai/provider-error";

const COLLECTION = "cloudflare_usage";

/** Cloudflare Workers AI free tier. */
export const DEFAULT_DAILY_NEURON_BUDGET = 10_000;
/** Reserved head-room so a dashboard user is not cut off mid-answer. */
export const DEFAULT_SAFETY_RESERVE = 500;
/**
 * Safety net used ONLY while actual neuron usage is unavailable: a cap on
 * requests per UTC day. It is a request count, not a neuron estimate.
 */
export const DEFAULT_DAILY_REQUEST_BUDGET = 400;

const USAGE_TTL_MS = 30_000;
const GRAPHQL_TTL_MS = 5 * 60_000;

export type QuotaSource = "graphql" | "response" | "unavailable";

export type CloudflareQuotaConfig = {
  configured: boolean;
  budget: number;
  safetyReserve: number;
  effectiveBudget: number;
  requestBudget: number;
};

export type CloudflareUsageView = CloudflareQuotaConfig & {
  date: string;
  requests: number;
  failedRequests: number;
  /** Actual neurons when known; null when Cloudflare did not report any. */
  neurons: number | null;
  neuronsSource: QuotaSource;
  byModel: Record<string, { requests: number; neurons: number | null }>;
  remainingNeurons: number | null;
  exhausted: boolean;
  exhaustionReason: string | null;
  warning: string | null;
  /** Next 00:00 UTC — when the quota resets. */
  resetsAt: string;
};

type DailyRecord = {
  date: string;
  requests: number;
  failedRequests: number;
  neurons: number;
  neuronsReported: boolean;
  byModel: Record<string, { requests: number; neurons: number }>;
  updatedAt: string;
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function cloudflareQuotaConfig(env: Record<string, string | undefined> = process.env): CloudflareQuotaConfig {
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const configured = Boolean(accountId && apiToken && !apiToken.includes("...") && !accountId.includes("YOUR-"));
  const budget = positiveInt(env.CLOUDFLARE_DAILY_NEURON_BUDGET, DEFAULT_DAILY_NEURON_BUDGET);
  const safetyReserve = Math.max(0, positiveInt(env.CLOUDFLARE_NEURON_SAFETY_RESERVE, DEFAULT_SAFETY_RESERVE));
  const effectiveBudget = Math.max(1, budget - Math.min(safetyReserve, budget - 1));
  const requestBudget = positiveInt(env.CLOUDFLARE_DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET);
  return { configured, budget, safetyReserve, effectiveBudget, requestBudget };
}

/** Today's UTC date (the quota day Cloudflare bills against). */
export function utcDateString(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Milliseconds until the next 00:00 UTC reset. */
export function msUntilUtcMidnight(at: Date = new Date()): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(0, next - at.getTime());
}

// -----------------------------------------------------------------------------
// Storage: Firestore with an in-process fallback (never localStorage).
// -----------------------------------------------------------------------------

const memory = new Map<string, DailyRecord>();

function emptyRecord(date: string): DailyRecord {
  return { date, requests: 0, failedRequests: 0, neurons: 0, neuronsReported: false, byModel: {}, updatedAt: new Date().toISOString() };
}

function normaliseRecord(date: string, data: Record<string, unknown> | null | undefined): DailyRecord {
  if (!data) return emptyRecord(date);
  const byModel: DailyRecord["byModel"] = {};
  const rawByModel = data.by_model && typeof data.by_model === "object" ? (data.by_model as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(rawByModel)) {
    const entry = (value ?? {}) as { requests?: unknown; neurons?: unknown };
    byModel[key] = {
      requests: typeof entry.requests === "number" ? entry.requests : 0,
      neurons: typeof entry.neurons === "number" ? entry.neurons : 0,
    };
  }
  return {
    date,
    requests: typeof data.requests === "number" ? data.requests : 0,
    failedRequests: typeof data.failed_requests === "number" ? data.failed_requests : 0,
    neurons: typeof data.neurons === "number" ? data.neurons : 0,
    neuronsReported: data.neurons_reported === true,
    byModel,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : new Date().toISOString(),
  };
}

async function readRecord(date: string): Promise<DailyRecord> {
  try {
    if (adminConfigured()) {
      const snap = await adminDb().collection(COLLECTION).doc(date).get();
      return normaliseRecord(date, snap.exists ? (snap.data() as Record<string, unknown>) : null);
    }
  } catch {
    /* Firestore unavailable: fall through to the process-local counter */
  }
  return memory.get(date) ?? emptyRecord(date);
}

async function writeRecord(record: DailyRecord): Promise<void> {
  memory.set(record.date, record);
  try {
    if (adminConfigured()) {
      await adminDb()
        .collection(COLLECTION)
        .doc(record.date)
        .set(
          {
            date: record.date,
            requests: record.requests,
            failed_requests: record.failedRequests,
            neurons: record.neurons,
            neurons_reported: record.neuronsReported,
            by_model: record.byModel,
            updated_at: record.updatedAt,
          },
          { merge: true },
        );
    }
  } catch {
    /* the in-process counter still gates this instance */
  }
}

// -----------------------------------------------------------------------------
// Actual usage from Cloudflare (best-effort; null when unavailable)
// -----------------------------------------------------------------------------

let graphqlCache: { at: number; date: string; neurons: number | null } | null = null;

/**
 * Actual Neuron usage from Cloudflare's GraphQL analytics
 * (Account Analytics → Workers AI). Any failure — token without analytics
 * permission, schema change, network — returns null: the caller then uses
 * response-reported usage or the request budget, and NEVER a token estimate.
 */
export async function fetchCloudflareNeurons(
  credentials: { accountId: string; apiToken: string },
  date = utcDateString(),
): Promise<number | null> {
  if (graphqlCache && graphqlCache.date === date && Date.now() - graphqlCache.at < GRAPHQL_TTL_MS) {
    return graphqlCache.neurons;
  }
  const from = `${date}T00:00:00Z`;
  const to = `${date}T23:59:59Z`;
  const query = `query QorvynaWorkersAiUsage($accountTag: String!, $from: Time!, $to: Time!) {
    viewer {
      accounts(filter: {accountTag: $accountTag}) {
        workersAiModelsAdaptiveGroups(filter: {datetime_geq: $from, datetime_leq: $to}, limit: 1000) {
          model
          sum { neurons }
        }
      }
    }
  }`;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiToken}` },
      body: JSON.stringify({ query, variables: { accountTag: credentials.accountId, from, to } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      graphqlCache = { at: Date.now(), date, neurons: null };
      return null;
    }
    const payload = (await res.json()) as {
      data?: { viewer?: { accounts?: Array<{ workersAiModelsAdaptiveGroups?: Array<{ sum?: { neurons?: unknown } }> }> } };
      errors?: unknown[];
    };
    if (Array.isArray(payload.errors) && payload.errors.length) {
      graphqlCache = { at: Date.now(), date, neurons: null };
      return null;
    }
    const groups = payload.data?.viewer?.accounts?.[0]?.workersAiModelsAdaptiveGroups ?? [];
    const total = groups.reduce((sum, group) => {
      const value = group?.sum?.neurons;
      return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);
    // Distinguish "query worked, no usage yet" (0) from "query failed" (null).
    graphqlCache = { at: Date.now(), date, neurons: total };
    return total;
  } catch {
    graphqlCache = { at: Date.now(), date, neurons: null };
    return null;
  }
}

// -----------------------------------------------------------------------------
// Usage view + gate
// -----------------------------------------------------------------------------

let usageCache: { at: number; date: string; view: CloudflareUsageView } | null = null;
/** Set when Cloudflare itself answered "quota exhausted" for today. */
let providerReportedExhaustion = false;

export function markCloudflareQuotaExhausted(): void {
  providerReportedExhaustion = true;
  usageCache = null;
}

function buildView(record: DailyRecord, config: CloudflareQuotaConfig, neurons: number | null, source: QuotaSource): CloudflareUsageView {
  const exhaustedByNeurons = neurons !== null && neurons >= config.effectiveBudget;
  const exhaustedByRequests = neurons === null && record.requests >= config.requestBudget;
  const exhausted = providerReportedExhaustion || exhaustedByNeurons || exhaustedByRequests;
  const exhaustionReason = providerReportedExhaustion
    ? "Cloudflare reported the daily quota as exhausted."
    : exhaustedByNeurons
      ? `Daily Neuron budget reached (${neurons} of ${config.effectiveBudget} effective).`
      : exhaustedByRequests
        ? `Daily request safety budget reached (${record.requests} of ${config.requestBudget}) while actual Neuron usage is unavailable.`
        : null;
  const usageForPercent = neurons ?? (config.requestBudget ? (record.requests / config.requestBudget) * config.effectiveBudget : 0);
  const percent = config.effectiveBudget > 0 ? usageForPercent / config.effectiveBudget : 0;
  const warning = !config.configured
    ? null
    : neurons === null && record.requests > 0
      ? "Actual Neuron usage is unavailable right now — requests are governed by the request safety budget until Cloudflare analytics can be read."
      : exhausted
        ? exhaustionReason
        : percent >= 0.8
        ? `Cloudflare Workers AI quota is ${Math.round(percent * 100)}% used for today (resets 00:00 UTC).`
        : null;
  return {
    ...config,
    date: record.date,
    requests: record.requests,
    failedRequests: record.failedRequests,
    neurons,
    neuronsSource: source,
    byModel: Object.fromEntries(
      Object.entries(record.byModel).map(([key, value]) => [key, { requests: value.requests, neurons: value.neurons > 0 ? value.neurons : null }]),
    ),
    remainingNeurons: neurons === null ? null : Math.max(0, config.effectiveBudget - neurons),
    exhausted,
    exhaustionReason,
    warning,
    resetsAt: new Date(Date.now() + msUntilUtcMidnight()).toISOString(),
  };
}

/** Today's usage. Reads actual Cloudflare usage when credentials allow it. */
export async function getCloudflareUsage(
  options: { accountId?: string; apiToken?: string; refresh?: boolean } = {},
): Promise<CloudflareUsageView> {
  const config = cloudflareQuotaConfig();
  const date = utcDateString();
  if (!options.refresh && usageCache && usageCache.date === date && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return usageCache.view;
  }
  const record = await readRecord(date);
  let neurons: number | null = null;
  let source: QuotaSource = "unavailable";
  if (options.accountId && options.apiToken) {
    const actual = await fetchCloudflareNeurons({ accountId: options.accountId, apiToken: options.apiToken }, date);
    if (actual !== null) {
      neurons = actual;
      source = "graphql";
    }
  }
  if (neurons === null && record.neuronsReported && record.neurons > 0) {
    neurons = record.neurons;
    source = "response";
  }
  const view = buildView(record, config, neurons, source);
  usageCache = { at: Date.now(), date, view };
  return view;
}

export type CloudflareRequestRecord = {
  model?: string;
  ok: boolean;
  /** Neurons the response itself reported — null when it did not. */
  neurons?: number | null;
  status?: number;
};

/**
 * Record one request that was actually sent (success or failure). Fire-and-
 * forget at call sites: a metrics failure must never fail a chat turn.
 */
export async function recordCloudflareRequest(input: CloudflareRequestRecord): Promise<void> {
  try {
    const date = utcDateString();
    const record = await readRecord(date);
    const key = input.model || "unknown";
    const current = record.byModel[key] ?? { requests: 0, neurons: 0 };
    record.requests += 1;
    if (!input.ok) record.failedRequests += 1;
    if (typeof input.neurons === "number" && Number.isFinite(input.neurons) && input.neurons > 0) {
      record.neurons += input.neurons;
      record.neuronsReported = true;
      current.neurons += input.neurons;
    }
    current.requests += 1;
    record.byModel[key] = current;
    record.updatedAt = new Date().toISOString();
    await writeRecord(record);
    // The gate must see fresh numbers immediately after a request.
    usageCache = null;
  } catch {
    /* metrics are best-effort */
  }
}

/**
 * Gate: throws a typed, fallback-eligible error when today's free quota is
 * used up, so the request is NEVER sent to an exhausted account. The error
 * carries the UTC reset time as `retryAt`.
 */
export async function assertCloudflareQuota(
  model: string,
  credentials?: { accountId: string; apiToken: string },
): Promise<void> {
  const config = cloudflareQuotaConfig();
  // Unconfigured deployments do nothing. Credentials passed in (from the
  // provider) count as configured even when this helper is called directly.
  if (!config.configured && !credentials) return;
  if (providerReportedExhaustion) throw quotaExhaustedError(model, "Cloudflare reported the daily quota as exhausted.");
  const view = await getCloudflareUsage(credentials ? { accountId: credentials.accountId, apiToken: credentials.apiToken } : {});
  if (!view.exhausted) return;
  throw quotaExhaustedError(model, view.exhaustionReason ?? "Cloudflare Workers AI free quota for today is exhausted.");
}

function quotaExhaustedError(model: string, reason: string): AIProviderError {
  return new AIProviderError({
    provider: "Cloudflare",
    model,
    status: 429,
    type: "rate_limit",
    code: "CLOUDFLARE_QUOTA_EXHAUSTED",
    detail: `${reason} The free quota resets at 00:00 UTC; paid billing is never enabled automatically. Continuing on another configured provider when one exists.`,
    retryAt: Date.now() + msUntilUtcMidnight(),
  });
}

/** Test hook: forget caches and flags between cases. */
export function resetCloudflareQuotaForTests(): void {
  memory.clear();
  usageCache = null;
  graphqlCache = null;
  providerReportedExhaustion = false;
}
