import "server-only";
import type { AIProvider } from "@/lib/ai/groq";
import type { AIRouteTarget } from "@/lib/ai/config";
import { AIProviderError } from "@/lib/ai/provider-error";

/** Provider catalogues expose IDs, not benchmark scores or guaranteed entitlements.
 * These conservative estimates only order *configured* candidates. A real
 * completion verifies availability and the circuit records recent failures. */
export type ModelProfile = {
  provider: string;
  model: string;
  coding: number;
  reasoning: number;
  contextTokens: number | null;
  tools: boolean;
  streaming: boolean;
  priority: number;
  availability: "unknown" | "healthy" | "cooldown";
  latencyMs: number | null;
  rateLimited: boolean;
};
type Health = { until: number; status: ModelProfile["availability"]; latencyMs: number | null; rateLimited: boolean };
const health = new Map<string, Health>();
const key = (route: Pick<AIRouteTarget, "provider" | "model" | "providerId">) => `${route.providerId ?? route.provider}:${route.model}`;

export function reportModelResult(route: AIRouteTarget, elapsedMs: number, error?: unknown) {
  const prior = health.get(key(route));
  if (!error) {
    health.set(key(route), { until: Date.now() + 60_000, status: "healthy", latencyMs: prior?.latencyMs ? Math.round(prior.latencyMs * 0.7 + elapsedMs * 0.3) : elapsedMs, rateLimited: false });
  } else if (error instanceof AIProviderError && error.fallbackEligible) {
    const rateLimited = error.type === "rate_limit";
    health.set(key(route), { until: Date.now() + (rateLimited ? 30_000 : 15_000), status: "cooldown", latencyMs: prior?.latencyMs ?? null, rateLimited });
  }
  if (health.size > 500) for (const [k, value] of health) if (value.until < Date.now()) health.delete(k);
}

export function modelProfile(route: AIRouteTarget): ModelProfile {
  const name = route.model.toLowerCase();
  const glm = route.provider === "GLM";
  const oss = /(?:^|\/)gpt-oss-120b/.test(name);
  const version = /glm-(\d+)(?:\.(\d+))?/.exec(name);
  const glmStrength = version ? Number(version[1]) * 10 + Number(version[2] ?? 0) : 0;
  const coding = glm ? (glmStrength >= 50 ? 95 + Math.min(12, glmStrength - 50) : glmStrength >= 47 ? 85 : 70) + (/code/.test(name) ? 4 : 0)
    : /claude.*opus|gpt-5|gemini-3.*pro/.test(name) ? 93
      : /claude.*sonnet|gemini.*pro|gpt-4\.1/.test(name) ? 84 : oss ? 68 : 55;
  const h = health.get(key(route));
  const recent = h && h.until > Date.now() ? h : undefined;
  return {
    provider: route.provider, model: route.model, coding,
    reasoning: glm ? coding : oss ? 73 : coding - 3,
    contextTokens: route.contextTokens ?? null, // Never invent unpublished context sizes.
    tools: route.client.supportsToolCalls === true,
    streaming: typeof route.client.streamChat === "function",
    priority: glm ? 15 : 0,
    availability: recent?.status ?? "unknown", latencyMs: recent?.latencyMs ?? null,
    rateLimited: recent?.rateLimited ?? false,
  };
}

/** Rank compatible, configured candidates; never pass a model without the
 * capabilities the execution path requires. A recent outage is a tie breaker,
 * not a permanent ban (all candidates must remain retryable after cooldown). */
export function rankModelRoutes(routes: AIRouteTarget[], mode: "chat" | "agent", toolsRequired = mode === "agent"): AIRouteTarget[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    if (!route.model.trim() || seen.has(key(route))) return false;
    seen.add(key(route));
    if (mode === "chat" && route.provider === "GLM") return false;
    return !toolsRequired || route.client.supportsToolCalls === true;
  }).sort((a, b) => {
    const score = (route: AIRouteTarget) => {
      const p = modelProfile(route);
      if (mode === "chat") return (/(?:^|\/)gpt-oss-120b/i.test(route.model) ? 1_000 : p.coding) - (p.availability === "cooldown" ? 1_200 : 0);
      return p.coding * 3 + p.reasoning + p.priority + (p.streaming ? 2 : 0)
        + (p.contextTokens ? Math.min(12, Math.floor(Math.log2(p.contextTokens / 1024))) : 0)
        - (p.availability === "cooldown" ? 200 : 0)
        - Math.min(25, Math.floor((p.latencyMs ?? 0) / 1_000));
    };
    return score(b) - score(a) || key(a).localeCompare(key(b));
  });
}

/** Registry discovery is best-effort; a model ID on an API catalogue is not an
 * entitlement. Actual model errors advance the executor to the next candidate. */
export async function discoverAgentModels(client: AIProvider, configuredModel: string, provider: AIRouteTarget["provider"], providerId: string): Promise<AIRouteTarget[]> {
  const candidates = new Map<string, number | undefined>([[configuredModel, undefined]]);
  if (client.listModels) {
    try {
      const available = await client.listModels();
      for (const item of available.slice(0, 200)) {
        if (provider === "GLM" ? /^glm-(?:5|[6-9])(?:[.-]|$)/i.test(item.id) && !/vision|image|embedding|asr/i.test(item.id)
          : /(?:code|sonnet|opus|pro|gpt-5|gpt-4\.1)/i.test(item.id) && !/vision|image|embedding|audio/i.test(item.id)) candidates.set(item.id, item.contextTokens);
      }
    } catch { /* Defer authentication/model errors to real completion; never fabricate health. */ }
  }
  return [...candidates].filter(([model]) => Boolean(model)).map(([model, contextTokens]) => ({ provider, providerId, model, client, tier: "high", contextTokens }));
}

/** Test/admin diagnostic reset. No persistent availability records are changed. */
export function resetRoutingHealth(): void { health.clear(); }
