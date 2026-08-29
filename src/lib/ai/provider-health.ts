// Shared, honest provider health probing.
//
// A GET /models "health check" LIES on many OpenAI-compatible services:
// OpenRouter (and most proxies/mirrors) answer 200 for /models WITHOUT any
// valid API key, so an operator with a revoked/typo'd key sees
// "ai: online" in /api/health and "AI Online" in the UI while EVERY real chat
// request fails with 401. The only truthful check is a tiny real
// /chat/completions call against the configured model.
//
// The UI polls this (AiStatus every 45s per open tab) and uptime monitors hit
// /api/health, so results are cached briefly per provider endpoint+model to
// protect provider rate limits. Within the TTL a cached result may lag reality
// by that much — an acceptable trade versus hammering provider quotas.

export type HealthProbeResult = { ok: boolean; status: number | null; detail: string };

const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 5_000;
const cache = new Map<string, { at: number; ok: boolean }>();

export function healthCacheKey(parts: (string | undefined)[]): string {
  return parts.map((p) => (p ?? "").trim().replace(/(sk|gsk|[A-Za-z0-9_-]{20,})/g, (m) => m.slice(-4))).join("|");
}

/** Test hook: the cache intentionally spans requests within a process. */
export function resetHealthCacheForTests(): void {
  cache.clear();
}

export async function cachedRealHealthCheck(key: string, probe: () => Promise<HealthProbeResult>): Promise<HealthProbeResult> {
  const hit = cache.get(key);
  const ttl = hit?.ok ? OK_TTL_MS : FAIL_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return { ok: hit.ok, status: null, detail: hit.ok ? "cached-ok" : "cached-fail" };
  const result = await probe();
  cache.set(key, { at: Date.now(), ok: result.ok });
  if (cache.size > 256) {
    // Bound memory: drop the oldest quarter when the cache grows unusually large.
    const keys = [...cache.keys()].slice(0, 64);
    for (const k of keys) cache.delete(k);
  }
  return result;
}
