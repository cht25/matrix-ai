import "server-only";
import type { AIProvider } from "@/lib/ai/groq";
import type { AIRouteTarget } from "@/lib/ai/config";
import { AIProviderError } from "@/lib/ai/provider-error";

// =============================================================================
// Capability-aware model routing.
//
//   Normal Chat  → GPT OSS 120B first, then other configured chat models.
//   Agent        → strongest *verified* GLM → other GLM → strongest Gemini →
//                  remaining tool-capable models (GPT OSS 120B included).
//
// Nothing here invents availability. A model ID is "listed" only when the
// provider's authenticated catalogue returned it, "missing" when a catalogue
// was returned without it, and "unknown" when the endpoint exposes no
// catalogue. Real completions then confirm or demote each route (cooldown).
// =============================================================================

export type CatalogStatus = "listed" | "missing" | "unknown";
export type ModelFamily = "glm" | "gemini" | "gpt-oss" | "other";

export type ModelProfile = {
  provider: string;
  model: string;
  family: ModelFamily;
  coding: number;
  reasoning: number;
  contextTokens: number | null;
  tools: boolean;
  streaming: boolean;
  priority: number;
  catalog: CatalogStatus;
  availability: "unknown" | "healthy" | "cooldown";
  latencyMs: number | null;
  rateLimited: boolean;
  lastError: string | null;
};
type Health = { until: number; status: ModelProfile["availability"]; latencyMs: number | null; rateLimited: boolean; lastError: string | null };
const health = new Map<string, Health>();
const key = (route: Pick<AIRouteTarget, "provider" | "model" | "providerId">) => `${route.providerId ?? route.provider}:${route.model}`;

/** The Agent's preferred primary when the provider really offers it. */
export const AGENT_PREFERRED_GLM_MODEL = "glm-5-turbo";

export function reportModelResult(route: AIRouteTarget, elapsedMs: number, error?: unknown) {
  const prior = health.get(key(route));
  if (!error) {
    health.set(key(route), { until: Date.now() + 5 * 60_000, status: "healthy", latencyMs: prior?.latencyMs ? Math.round(prior.latencyMs * 0.7 + elapsedMs * 0.3) : elapsedMs, rateLimited: false, lastError: null });
  } else if (error instanceof AIProviderError) {
    const rateLimited = error.type === "rate_limit";
    // Credential, billing and unknown-model failures do not heal in seconds;
    // keep those routes at the back for longer so each request does not pay
    // for the same dead call again. Transient outages recover quickly.
    const cooldownMs = error.modelUnavailable || error.type === "authentication" || error.type === "billing" ? 10 * 60_000
      : rateLimited ? 30_000 : error.type === "timeout" ? 60_000 : 20_000;
    health.set(key(route), { until: Date.now() + cooldownMs, status: "cooldown", latencyMs: prior?.latencyMs ?? null, rateLimited, lastError: `${error.type}${error.status ? ` ${error.status}` : ""}: ${error.detail}`.slice(0, 200) });
  }
  if (health.size > 500) for (const [k, value] of health) if (value.until < Date.now()) health.delete(k);
}

export function modelFamily(route: Pick<AIRouteTarget, "provider" | "model">): ModelFamily {
  const name = route.model.toLowerCase();
  if (route.provider === "GLM" || /(?:^|\/)glm-\d/.test(name)) return "glm";
  if (route.provider === "Gemini" || /(?:^|\/)gemini-\d/.test(name)) return "gemini";
  if (/(?:^|\/)gpt-oss-120b/.test(name)) return "gpt-oss";
  return "other";
}

/** `glm-4.7` → 47, `glm-5-turbo` → 50, `glm-5.1` → 51. 0 when unparseable. */
export function glmStrength(model: string): number {
  const version = /glm-(\d+)(?:\.(\d+))?/.exec(model.toLowerCase());
  return version ? Number(version[1]) * 10 + Number(version[2] ?? 0) : 0;
}

/** Text/coding GLM models only — vision, speech, image and tiny tiers are not Agent models. */
export function isGlmAgentCandidate(id: string): boolean {
  const name = id.toLowerCase();
  if (!/^glm-\d/.test(name)) return false;
  if (/(?:\d)v(?:-|$)|vision|image|embedding|asr|tts|voice|realtime|video|ocr|flashx?|air(?:x)?|long|alltools/.test(name)) return false;
  return glmStrength(name) >= 45;
}

function geminiScore(model: string): { coding: number; ok: boolean } {
  const name = model.toLowerCase();
  const match = /gemini-(\d+(?:\.\d+)?)-(pro|flash)(-lite)?/.exec(name);
  if (!match) return { coding: 60, ok: false };
  const version = Number(match[1]);
  const base = match[2] === "pro" ? 80 : 68;
  return { coding: Math.min(96, Math.round(base + version * 4)) - (match[3] ? 10 : 0), ok: true };
}

/** Stable text-generation Gemini models suitable for file generation. */
export function isGeminiAgentCandidate(id: string): boolean {
  const name = id.toLowerCase();
  if (!/^gemini-\d/.test(name)) return false;
  if (/tts|image|embedding|audio|live|vision|lite|learnlm|robotics|computer-use|nano|banana|veo|imagen|aqa|gemma/.test(name)) return false;
  return geminiScore(name).ok && Number(/gemini-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0) >= 2;
}

export function modelProfile(route: AIRouteTarget): ModelProfile {
  const name = route.model.toLowerCase();
  const family = modelFamily(route);
  const oss = family === "gpt-oss";
  const strength = glmStrength(name);
  const coding = family === "glm"
    ? (strength >= 50 ? 95 + Math.min(12, strength - 50) : strength >= 47 ? 88 : strength >= 46 ? 85 : strength >= 45 ? 80 : 70)
      + (/code/.test(name) ? 2 : 0)
      // GLM-5-Turbo is the agent-tuned tier: prefer it over same-generation siblings when it exists.
      + (name === AGENT_PREFERRED_GLM_MODEL ? 6 : 0)
    : family === "gemini" ? geminiScore(name).coding
      : /claude.*opus|gpt-5/.test(name) ? 93
        : /claude.*sonnet|gpt-4\.1/.test(name) ? 84 : oss ? 68 : 55;
  const h = health.get(key(route));
  const recent = h && h.until > Date.now() ? h : undefined;
  return {
    provider: route.provider, model: route.model, family, coding,
    reasoning: family === "glm" ? coding : oss ? 73 : coding - 3,
    contextTokens: route.contextTokens ?? null, // Never invent unpublished context sizes.
    tools: route.client.supportsToolCalls === true,
    streaming: typeof route.client.streamChat === "function",
    priority: family === "glm" ? 15 : 0,
    catalog: route.catalog ?? "unknown",
    availability: recent?.status ?? "unknown", latencyMs: recent?.latencyMs ?? null,
    rateLimited: recent?.rateLimited ?? false,
    lastError: recent?.lastError ?? null,
  };
}

const AGENT_FAMILY_ORDER: Record<ModelFamily, number> = { glm: 0, gemini: 1, "gpt-oss": 2, other: 2 };

/** Rank compatible, configured candidates; never pass a model without the
 * capabilities the execution path requires. A recent outage or a model the
 * provider's own catalogue does not list moves a route to the back — it is
 * not a permanent ban (all candidates remain retryable after cooldown). */
export function rankModelRoutes(routes: AIRouteTarget[], mode: "chat" | "agent", toolsRequired = mode === "agent"): AIRouteTarget[] {
  const seen = new Map<string, AIRouteTarget>();
  for (const route of routes) {
    if (!route.model.trim()) continue;
    if (mode === "chat" && route.provider === "GLM") continue;
    if (toolsRequired && route.client.supportsToolCalls !== true) continue;
    const prior = seen.get(key(route));
    // Keep the entry that carries catalogue evidence.
    if (!prior || ((prior.catalog ?? "unknown") === "unknown" && (route.catalog ?? "unknown") !== "unknown")) seen.set(key(route), route);
  }
  const score = (route: AIRouteTarget) => {
    const p = modelProfile(route);
    if (mode === "chat") return p.family === "gpt-oss" ? 1_000 : p.coding;
    return p.coding * 3 + p.reasoning + p.priority + (p.streaming ? 2 : 0)
      + (p.contextTokens ? Math.min(12, Math.floor(Math.log2(p.contextTokens / 1024))) : 0)
      - Math.min(25, Math.floor((p.latencyMs ?? 0) / 4_000));
  };
  const tier = (route: AIRouteTarget) => {
    const p = modelProfile(route);
    // 0 = usable now, 1 = catalogue says the ID is absent, 2 = failing right now.
    return p.availability === "cooldown" ? 2 : p.catalog === "missing" ? 1 : 0;
  };
  return [...seen.values()].sort((a, b) =>
    tier(a) - tier(b)
    || (mode === "agent" ? AGENT_FAMILY_ORDER[modelFamily(a)] - AGENT_FAMILY_ORDER[modelFamily(b)] : 0)
    || score(b) - score(a)
    || key(a).localeCompare(key(b)));
}

const MAX_DISCOVERED_PER_PROVIDER = 4;

/** Discover suitable Agent models from the provider's authenticated
 * catalogue and record whether the configured ID is actually listed. A
 * catalogue entry is still not an entitlement: real completion errors advance
 * the executor to the next candidate. */
export async function discoverAgentModels(client: AIProvider, configuredModel: string, provider: AIRouteTarget["provider"], providerId: string): Promise<AIRouteTarget[]> {
  const candidates = new Map<string, { contextTokens?: number; catalog: CatalogStatus }>();
  if (configuredModel) candidates.set(configuredModel, { catalog: "unknown" });
  if (client.listModels) {
    try {
      const available = await client.listModels();
      const live = (client as AIProvider & { lastCatalogSource?: string }).lastCatalogSource !== "static";
      const ids = new Set(available.map((item) => item.id));
      if (configuredModel && live) candidates.set(configuredModel, { catalog: ids.has(configuredModel) ? "listed" : "missing", contextTokens: available.find((item) => item.id === configuredModel)?.contextTokens });
      const suitable = available
        .filter((item) => provider === "GLM" ? isGlmAgentCandidate(item.id)
          : provider === "Gemini" ? isGeminiAgentCandidate(item.id)
            : /(?:code|sonnet|opus|gpt-5|gpt-4\.1|gpt-oss-120b)/i.test(item.id) && !/vision|image|embedding|audio|tts|whisper|guard/i.test(item.id))
        .map((item) => ({ item, rank: modelProfile({ provider, providerId, model: item.id, client }).coding }))
        .sort((a, b) => b.rank - a.rank || a.item.id.localeCompare(b.item.id))
        .slice(0, MAX_DISCOVERED_PER_PROVIDER);
      for (const { item } of suitable) {
        if (!candidates.has(item.id)) candidates.set(item.id, { contextTokens: item.contextTokens, catalog: live ? "listed" : "unknown" });
      }
    } catch { /* Defer authentication/model errors to real completion; never fabricate health. */ }
  }
  return [...candidates].filter(([model]) => Boolean(model)).map(([model, meta]) => ({ provider, providerId, model, client, tier: "high" as const, contextTokens: meta.contextTokens, catalog: meta.catalog }));
}

export type RouteDiagnostic = {
  position: number;
  provider: string;
  provider_id: string | null;
  model: string;
  family: ModelFamily;
  catalog: CatalogStatus;
  availability: ModelProfile["availability"];
  tools: boolean;
  streaming: boolean;
  latency_ms: number | null;
  last_error: string | null;
};

/** Operator/UI view of a ranked chain. Contains no credentials. */
export function describeRoutes(routes: AIRouteTarget[]): RouteDiagnostic[] {
  return routes.map((route, index) => {
    const p = modelProfile(route);
    return {
      position: index + 1, provider: route.provider, provider_id: route.providerId ?? null, model: route.model,
      family: p.family, catalog: p.catalog, availability: p.availability, tools: p.tools, streaming: p.streaming,
      latency_ms: p.latencyMs, last_error: p.lastError,
    };
  });
}

/** Test/admin diagnostic reset. No persistent availability records are changed. */
export function resetRoutingHealth(): void { health.clear(); }
