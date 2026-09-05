"use client";

// =============================================================================
// Tiny request cache + in-flight deduplication.
//
// Several components legitimately render more than once per page (the AI status
// pill and the notifications bell each appear in the mobile top bar AND the
// desktop chrome). Without coordination that produced duplicate requests:
//
//     POST /api/rpc notifications_list
//     POST /api/rpc notifications_list      <- same data, same moment
//
// `cachedRequest` collapses concurrent callers onto one promise and serves a
// short-lived cached value to later callers, so N components cost 1 request.
// =============================================================================

type Entry<T> = { value: T; expires: number };

const cache = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const subscribers = new Map<string, Set<(value: unknown) => void>>();

/**
 * Run `loader` for `key`, deduplicating concurrent calls and caching the
 * result for `ttlMs`. Pass `force` to bypass the cache (e.g. a manual refresh).
 */
export async function cachedRequest<T>(
  key: string,
  loader: () => Promise<T>,
  { ttlMs = 30_000, force = false }: { ttlMs?: number; force?: boolean } = {},
): Promise<T> {
  const now = Date.now();

  if (!force) {
    const hit = cache.get(key);
    if (hit && hit.expires > now) return hit.value as T;
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;
  }

  const promise = loader()
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + ttlMs });
      subscribers.get(key)?.forEach((fn) => fn(value));
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** Read a cached value without triggering a request. */
export function peekCache<T>(key: string): T | undefined {
  const hit = cache.get(key);
  return hit && hit.expires > Date.now() ? (hit.value as T) : undefined;
}

/** Drop a cached entry so the next read refetches (e.g. after a mutation). */
export function invalidate(key: string): void {
  cache.delete(key);
}

/**
 * Subscribe to updates for a key. Every mounted copy of a component stays in
 * sync from a single request.
 */
export function subscribe<T>(key: string, fn: (value: T) => void): () => void {
  const set = subscribers.get(key) ?? new Set();
  set.add(fn as (value: unknown) => void);
  subscribers.set(key, set);
  return () => {
    set.delete(fn as (value: unknown) => void);
    if (set.size === 0) subscribers.delete(key);
  };
}
