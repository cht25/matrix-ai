// Groq account manager.
//
// An administrator can connect several Groq accounts. Each one is an
// independent credential with its own provider limits. This module is the one
// place that knows about them:
//
//   • where the keys come from (environment + encrypted admin records),
//   • what each account's limits currently are — read from the rate-limit
//     headers Groq returns on every response, never guessed,
//   • which account a request should use, and which to try next when one is
//     limited, rejected or failing.
//
// Rotation only ever happens after the provider itself has said an account is
// limited (HTTP 429 / exhausted headers) or unusable. Requests are never
// spread across accounts to exceed what a single account is allowed.
import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import { canEncryptSecrets, decryptSecret, encryptSecret } from "@/lib/ai/image/config";
import { RpcError } from "@/lib/server/errors";

export type ProviderAccount = {
  id: string;
  label: string;
  source: "env" | "admin";
  key: string;
  enabled: boolean;
};

type Window = {
  limitRequests: number | null;
  remainingRequests: number | null;
  requestsResetAt: number;
  limitTokens: number | null;
  remainingTokens: number | null;
  tokensResetAt: number;
  cooldownUntil: number;
  rateLimitHits: number;
  /** Consecutive transport/server failures for this model, and the pause they earned. */
  failures: number;
  failingUntil: number;
  observedAt: number;
};

type AccountState = {
  windows: Map<string, Window>;
  /** Account-wide pause (rejected key). */
  pausedUntil: number;
  invalid: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastOkAt: number | null;
  lastUsedAt: number;
  /** Requests in the last minute: [at, tokens]. */
  recent: Array<[number, number]>;
  requests: number;
  rotationsAway: number;
};

const INVALID_RETRY_MS = 10 * 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
const ADMIN_CACHE_MS = 60_000;

let adminAccounts: ProviderAccount[] = [];
let adminLoadedAt = 0;
let adminLoading: Promise<void> | null = null;
const states = new Map<string, AccountState>();
let clock: () => number = () => Date.now();

function secret(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length >= 8 ? trimmed : "";
}

export function accountIdForKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Keys from the environment: GROQ_API_KEY, GROQ_API_KEY_2 … _8, and GROQ_API_KEYS (comma separated). */
export function envAccounts(): ProviderAccount[] {
  const keys: string[] = [];
  const add = (value: string | undefined) => {
    const key = secret(value);
    if (key && !keys.includes(key)) keys.push(key);
  };
  add(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 8; i += 1) add(process.env[`GROQ_API_KEY_${i}`]);
  for (const part of (process.env.GROQ_API_KEYS ?? "").split(",")) add(part);
  return keys.map((key, index) => ({ id: accountIdForKey(key), label: index === 0 ? "Primary (environment)" : `Environment account ${index + 1}`, source: "env" as const, key, enabled: true }));
}

/** Every connected account, environment first. One entry per distinct key. */
export function listAccounts(): ProviderAccount[] {
  const seen = new Set<string>();
  const out: ProviderAccount[] = [];
  for (const account of [...envAccounts(), ...adminAccounts]) {
    if (seen.has(account.id)) continue;
    seen.add(account.id);
    out.push(account);
  }
  return out;
}

function state(id: string): AccountState {
  let current = states.get(id);
  if (!current) {
    current = { windows: new Map(), pausedUntil: 0, invalid: false, lastError: null, lastErrorAt: null, lastOkAt: null, lastUsedAt: 0, recent: [], requests: 0, rotationsAway: 0 };
    states.set(id, current);
  }
  return current;
}

function windowFor(id: string, model: string): Window {
  const account = state(id);
  let current = account.windows.get(model);
  if (!current) {
    current = { limitRequests: null, remainingRequests: null, requestsResetAt: 0, limitTokens: null, remainingTokens: null, tokensResetAt: 0, cooldownUntil: 0, rateLimitHits: 0, failures: 0, failingUntil: 0, observedAt: 0 };
    account.windows.set(model, current);
  }
  return current;
}

/** "2m59.56s", "7.66s", "1h2m3s", "450ms" or plain seconds → milliseconds. */
export function parseResetDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const amount = Number(match[1]);
    total += match[2] === "h" ? amount * 3_600_000 : match[2] === "m" ? amount * 60_000 : match[2] === "s" ? amount * 1000 : amount;
  }
  return matched ? Math.round(total) : null;
}

/** When this account can next serve `model`, or 0 when it can now. */
function availableAt(account: ProviderAccount, model: string, tokens: number, now: number): number {
  const current = state(account.id);
  let at = 0;
  if (current.pausedUntil > now) at = Math.max(at, current.pausedUntil);
  const window = current.windows.get(model);
  if (window) {
    if (window.cooldownUntil > now) at = Math.max(at, window.cooldownUntil);
    if (window.failingUntil > now) at = Math.max(at, window.failingUntil);
    if (window.remainingRequests !== null && window.remainingRequests <= 0 && window.requestsResetAt > now) at = Math.max(at, window.requestsResetAt);
    if (window.remainingTokens !== null && window.remainingTokens < tokens && window.tokensResetAt > now) {
      // A request larger than the whole per-minute allowance can never fit;
      // waiting does not help, so let the provider answer for itself.
      if (window.limitTokens === null || tokens <= window.limitTokens) at = Math.max(at, window.tokensResetAt);
    }
  }
  return at;
}

export type AccountChoice = { account: ProviderAccount | null; nextAvailableAt: number | null; considered: number };

/**
 * The account a request should use: among the accounts that can serve it now,
 * the one with the most token headroom, then the least recently used.
 */
export function selectAccount(model: string, estimatedTokens: number, exclude: ReadonlySet<string> = new Set()): AccountChoice {
  const now = clock();
  const candidates = listAccounts().filter((account) => account.enabled && !exclude.has(account.id));
  let best: { account: ProviderAccount; headroom: number; used: number } | null = null;
  let soonest: number | null = null;
  for (const account of candidates) {
    const at = availableAt(account, model, estimatedTokens, now);
    if (at > now) {
      soonest = soonest === null ? at : Math.min(soonest, at);
      continue;
    }
    const window = state(account.id).windows.get(model);
    const fresh = window && window.tokensResetAt > now && window.remainingTokens !== null;
    const headroom = fresh ? (window.remainingTokens as number) : Number.MAX_SAFE_INTEGER;
    const used = state(account.id).lastUsedAt;
    if (!best || headroom > best.headroom || (headroom === best.headroom && used < best.used)) best = { account, headroom, used };
  }
  if (best) state(best.account.id).lastUsedAt = now;
  return { account: best?.account ?? null, nextAvailableAt: best ? null : soonest, considered: candidates.length };
}

/** Earliest moment any connected account can serve `model` again (null = now / unknown). */
export function nextAvailability(model: string, estimatedTokens = 0): number | null {
  const now = clock();
  let soonest: number | null = null;
  for (const account of listAccounts().filter((item) => item.enabled)) {
    const at = availableAt(account, model, estimatedTokens, now);
    if (at <= now) return null;
    soonest = soonest === null ? at : Math.min(soonest, at);
  }
  return soonest;
}

/** Record the limits the provider reported on a response. */
export function observeHeaders(id: string, model: string, headers: Headers | null | undefined): void {
  if (!headers || typeof headers.get !== "function") return;
  const now = clock();
  const window = windowFor(id, model);
  const number = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const limitRequests = number("x-ratelimit-limit-requests");
  const remainingRequests = number("x-ratelimit-remaining-requests");
  const limitTokens = number("x-ratelimit-limit-tokens");
  const remainingTokens = number("x-ratelimit-remaining-tokens");
  const resetRequests = parseResetDuration(headers.get("x-ratelimit-reset-requests"));
  const resetTokens = parseResetDuration(headers.get("x-ratelimit-reset-tokens"));
  if (limitRequests !== null) window.limitRequests = limitRequests;
  if (remainingRequests !== null) window.remainingRequests = remainingRequests;
  if (limitTokens !== null) window.limitTokens = limitTokens;
  if (remainingTokens !== null) window.remainingTokens = remainingTokens;
  if (resetRequests !== null) window.requestsResetAt = now + resetRequests;
  if (resetTokens !== null) window.tokensResetAt = now + resetTokens;
  if (remainingRequests !== null || remainingTokens !== null) window.observedAt = now;
}

export function markOk(id: string, model: string, tokens: number): void {
  const now = clock();
  const current = state(id);
  current.invalid = false;
  current.lastOkAt = now;
  current.requests += 1;
  current.recent = [...current.recent.filter(([at]) => now - at < 60_000), [now, Math.max(0, tokens)]];
  const window = windowFor(id, model);
  window.rateLimitHits = 0;
  window.failures = 0;
  window.failingUntil = 0;
}

/**
 * The provider said this account is limited for `model`. It is not selected
 * again until the provider's own retry time has passed; without one the pause
 * doubles on each consecutive limit (30 s, 60 s, … up to 10 min).
 */
export function markRateLimited(id: string, model: string, retryAfterMs: number | null, detail?: string): number {
  const now = clock();
  const window = windowFor(id, model);
  window.rateLimitHits += 1;
  const backoff = Math.min(MAX_COOLDOWN_MS, 30_000 * 2 ** (window.rateLimitHits - 1));
  const wait = retryAfterMs && retryAfterMs > 0 ? Math.min(retryAfterMs, 24 * 3_600_000) : backoff;
  window.cooldownUntil = now + wait;
  const current = state(id);
  current.lastError = `Rate limited${detail ? `: ${detail.slice(0, 160)}` : ""}`;
  current.lastErrorAt = now;
  current.rotationsAway += 1;
  return window.cooldownUntil;
}

/** The key was rejected. The account is skipped, then probed again later in case the rejection was temporary. */
export function markInvalid(id: string, detail: string): void {
  const now = clock();
  const current = state(id);
  current.invalid = true;
  current.pausedUntil = now + INVALID_RETRY_MS;
  current.lastError = `Credential rejected: ${detail.slice(0, 160)}`;
  current.lastErrorAt = now;
  current.rotationsAway += 1;
}

/**
 * Transport or server failure for one model on one account. A single failure
 * changes nothing (the caller's own retry policy handles it); from the third
 * consecutive failure the pair is rested briefly (2 s, 4 s, … 60 s) so other
 * accounts are preferred. Other models on the account are unaffected.
 */
export function markFailure(id: string, model: string, detail: string): void {
  const now = clock();
  const current = state(id);
  const window = windowFor(id, model);
  window.failures += 1;
  if (window.failures >= 3) window.failingUntil = now + Math.min(60_000, 2000 * 2 ** (window.failures - 3));
  current.lastError = detail.slice(0, 200);
  current.lastErrorAt = now;
  current.rotationsAway += 1;
}

/** Why no account can serve `model` right now. */
export function unavailableReason(model: string): "rate_limit" | "authentication" | "provider_unavailable" {
  const now = clock();
  const accounts = listAccounts().filter((item) => item.enabled);
  let invalid = 0;
  for (const account of accounts) {
    const current = state(account.id);
    const window = current.windows.get(model);
    if (window && (window.cooldownUntil > now || (window.remainingRequests !== null && window.remainingRequests <= 0 && window.requestsResetAt > now) || (window.remainingTokens !== null && window.tokensResetAt > now && window.failingUntil <= now && current.pausedUntil <= now))) return "rate_limit";
    if (current.invalid && current.pausedUntil > now) invalid += 1;
  }
  return accounts.length > 0 && invalid === accounts.length ? "authentication" : "provider_unavailable";
}

export type AccountStatus = {
  id: string;
  label: string;
  source: "env" | "admin";
  key_hint: string;
  enabled: boolean;
  state: "ready" | "rate_limited" | "paused" | "invalid" | "disabled";
  available_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_ok_at: string | null;
  requests_last_minute: number;
  tokens_last_minute: number;
  requests_total: number;
  rotations_away: number;
  models: Array<{
    model: string;
    limit_requests: number | null;
    remaining_requests: number | null;
    limit_tokens: number | null;
    remaining_tokens: number | null;
    cooldown_until: string | null;
    observed_at: string | null;
  }>;
};

const iso = (value: number | null): string | null => (value ? new Date(value).toISOString() : null);

/** Admin view. Never includes a key — only its last four characters. */
export function accountStatuses(): AccountStatus[] {
  const now = clock();
  return listAccounts().map((account) => {
    const current = state(account.id);
    const recent = current.recent.filter(([at]) => now - at < 60_000);
    const cooling = [...current.windows.values()].map((window) => window.cooldownUntil).filter((at) => at > now);
    const failing = [...current.windows.values()].map((window) => window.failingUntil).filter((at) => at > now);
    const status: AccountStatus["state"] = !account.enabled ? "disabled" : current.invalid && current.pausedUntil > now ? "invalid" : cooling.length ? "rate_limited" : failing.length ? "paused" : "ready";
    const until = Math.max(current.pausedUntil > now ? current.pausedUntil : 0, ...cooling, ...failing, 0);
    return {
      id: account.id,
      label: account.label,
      source: account.source,
      key_hint: `…${account.key.slice(-4)}`,
      enabled: account.enabled,
      state: status,
      available_at: until ? iso(until) : null,
      last_error: current.lastError,
      last_error_at: iso(current.lastErrorAt),
      last_ok_at: iso(current.lastOkAt),
      requests_last_minute: recent.length,
      tokens_last_minute: recent.reduce((sum, [, tokens]) => sum + tokens, 0),
      requests_total: current.requests,
      rotations_away: current.rotationsAway,
      models: [...current.windows.entries()].map(([model, window]) => ({
        model,
        limit_requests: window.limitRequests,
        remaining_requests: window.requestsResetAt > now ? window.remainingRequests : window.limitRequests,
        limit_tokens: window.limitTokens,
        remaining_tokens: window.tokensResetAt > now ? window.remainingTokens : window.limitTokens,
        cooldown_until: window.cooldownUntil > now ? iso(window.cooldownUntil) : null,
        observed_at: iso(window.observedAt || null),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Admin-registered accounts (encrypted at rest)
// ---------------------------------------------------------------------------

const COLLECTION = "provider_accounts";

/** Load admin-registered accounts into memory (cached; safe to call on every request). */
export async function ensureAccounts(d: Db | null | undefined, force = false): Promise<void> {
  if (!d) return;
  const now = Date.now();
  if (!force && now - adminLoadedAt < ADMIN_CACHE_MS) return;
  if (adminLoading) return adminLoading;
  adminLoading = (async () => {
    try {
      const snap = await d.collection(COLLECTION).get();
      const next: ProviderAccount[] = [];
      for (const doc of snap.docs) {
        const data = doc.data() as { provider?: string; label?: string; api_key_encrypted?: string; enabled?: boolean };
        if (data.provider !== "groq" || !data.api_key_encrypted) continue;
        const key = secret(decryptSecret(data.api_key_encrypted));
        if (!key) continue; // encrypted with a secret this deployment no longer has
        next.push({ id: accountIdForKey(key), label: String(data.label ?? "Groq account").slice(0, 60), source: "admin", key, enabled: data.enabled !== false });
      }
      adminAccounts = next;
      adminLoadedAt = Date.now();
    } catch {
      // Storage is unreachable: keep whatever was loaded before. Environment
      // accounts keep working either way.
      adminLoadedAt = Date.now() - ADMIN_CACHE_MS + 5_000;
    } finally {
      adminLoading = null;
    }
  })();
  return adminLoading;
}

export type StoredAccount = { doc_id: string; id: string; label: string; enabled: boolean; key_hint: string; created_at: string | null; readable: boolean };

export async function listStoredAccounts(d: Db): Promise<StoredAccount[]> {
  const snap = await d.collection(COLLECTION).get();
  return snap.docs
    .filter((doc) => doc.data().provider === "groq")
    .map((doc) => {
      const data = doc.data() as { label?: string; enabled?: boolean; key_hint?: string; account_id?: string; api_key_encrypted?: string; created_at?: { toDate?: () => Date } };
      return {
        doc_id: doc.id,
        id: String(data.account_id ?? ""),
        label: String(data.label ?? "Groq account"),
        enabled: data.enabled !== false,
        key_hint: String(data.key_hint ?? ""),
        created_at: data.created_at?.toDate?.().toISOString() ?? null,
        readable: Boolean(data.api_key_encrypted && decryptSecret(data.api_key_encrypted)),
      };
    });
}

/** Register a Groq key. The key is encrypted before it is written and is never returned. */
export async function addStoredAccount(d: Db, input: { label: string; apiKey: string; addedBy: string }): Promise<{ doc_id: string; id: string }> {
  const key = secret(input.apiKey);
  if (!key || !/^gsk_[A-Za-z0-9_-]{20,}$/.test(key)) throw new RpcError("INVALID_API_KEY", 400, "That does not look like a Groq API key (it should start with gsk_).");
  if (!canEncryptSecrets()) throw new RpcError("SECRET_STORAGE_UNAVAILABLE", 503, "Set PROVIDER_SECRET_KEY so keys can be stored encrypted.");
  const id = accountIdForKey(key);
  if (listAccounts().some((account) => account.id === id) || (await listStoredAccounts(d)).some((account) => account.id === id)) {
    throw new RpcError("ACCOUNT_EXISTS", 409, "This key is already connected.");
  }
  const ref = await d.collection(COLLECTION).add({
    provider: "groq",
    label: input.label.trim().slice(0, 60) || "Groq account",
    api_key_encrypted: encryptSecret(key),
    key_hint: `…${key.slice(-4)}`,
    account_id: id,
    enabled: true,
    added_by: input.addedBy,
    created_at: nowTs(),
    updated_at: nowTs(),
  });
  await ensureAccounts(d, true);
  return { doc_id: ref.id, id };
}

export async function updateStoredAccount(d: Db, docId: string, patch: { label?: string; enabled?: boolean }): Promise<void> {
  const ref = d.collection(COLLECTION).doc(docId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.provider !== "groq") throw new RpcError("NOT_FOUND", 404);
  await ref.set({
    ...(typeof patch.label === "string" ? { label: patch.label.trim().slice(0, 60) || "Groq account" } : {}),
    ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    updated_at: nowTs(),
  }, { merge: true });
  await ensureAccounts(d, true);
}

export async function removeStoredAccount(d: Db, docId: string): Promise<void> {
  const ref = d.collection(COLLECTION).doc(docId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.provider !== "groq") throw new RpcError("NOT_FOUND", 404);
  await ref.delete();
  await ensureAccounts(d, true);
}

/** Persist the current health picture so it survives a restart and is visible to admins. */
export async function persistAccountStatus(d: Db): Promise<void> {
  const statuses = accountStatuses();
  await Promise.all(statuses.map((status) => d.collection("provider_account_status").doc(status.id).set({ ...status, provider: "groq", updated_at: nowTs() }, { merge: false }).catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function resetAccountsForTests(options: { clock?: () => number; admin?: ProviderAccount[] } = {}): void {
  states.clear();
  adminAccounts = options.admin ?? [];
  adminLoadedAt = options.admin ? Date.now() : 0;
  clock = options.clock ?? (() => Date.now());
}
