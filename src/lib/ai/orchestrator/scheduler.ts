// Token-per-minute aware scheduling for the model pool.
//
// Each model has a rolling 60-second token ledger and an optional cool-down.
// The ledger is an estimate kept per server instance (it is not shared between
// instances and is not the provider's own counter); a real rate-limit response
// from the provider always wins and puts the model into cool-down.

import { modelByKey, modelTpm } from "@/lib/ai/models/registry";

const WINDOW_MS = 60_000;
type Ledger = { entries: { at: number; tokens: number }[]; coolUntil: number };
const STATE = "__matrixModelScheduler";
function ledgers(): Map<string, Ledger> {
  const root = globalThis as Record<string, unknown>;
  return (root[STATE] ??= new Map<string, Ledger>()) as Map<string, Ledger>;
}
function ledger(key: string): Ledger {
  const all = ledgers();
  let entry = all.get(key);
  if (!entry) { entry = { entries: [], coolUntil: 0 }; all.set(key, entry); }
  return entry;
}
function used(entry: Ledger, now: number): number {
  entry.entries = entry.entries.filter((item) => now - item.at < WINDOW_MS);
  return entry.entries.reduce((sum, item) => sum + item.tokens, 0);
}

export type Reservation = { ok: true; release: (actualTokens?: number) => void } | { ok: false; reason: "cooldown" | "budget" | "too_large"; waitMs: number };

/** Reserve estimated tokens for one request, or say why it cannot run now. */
export function reserveTokens(modelKey: string, estimatedTokens: number, now: number = Date.now()): Reservation {
  const spec = modelByKey(modelKey);
  const budget = spec ? modelTpm(spec) : 6_000;
  const entry = ledger(modelKey);
  if (entry.coolUntil > now) return { ok: false, reason: "cooldown", waitMs: entry.coolUntil - now };
  const tokens = Math.max(1, Math.ceil(estimatedTokens));
  // A request larger than a whole minute's budget can never be scheduled.
  if (tokens > budget) return { ok: false, reason: "too_large", waitMs: 0 };
  const current = used(entry, now);
  if (current + tokens > budget) {
    const oldest = entry.entries[0]?.at ?? now;
    return { ok: false, reason: "budget", waitMs: Math.max(250, WINDOW_MS - (now - oldest)) };
  }
  const record = { at: now, tokens };
  entry.entries.push(record);
  return {
    ok: true,
    // Replace the estimate with the provider-reported total when known.
    release: (actual) => { if (typeof actual === "number" && actual > 0) record.tokens = Math.ceil(actual); },
  };
}

/** Put a model into cool-down after a real provider rate-limit response. */
export function coolDown(modelKey: string, ms: number, now: number = Date.now()): void {
  const entry = ledger(modelKey);
  entry.coolUntil = Math.max(entry.coolUntil, now + Math.min(Math.max(ms, 1_000), 120_000));
}
export function cooldownRemainingMs(modelKey: string, now: number = Date.now()): number {
  return Math.max(0, (ledgers().get(modelKey)?.coolUntil ?? 0) - now);
}
export function tokensUsedLastMinute(modelKey: string, now: number = Date.now()): number {
  const entry = ledgers().get(modelKey);
  return entry ? used(entry, now) : 0;
}
/** Tests only. */
export function resetScheduler(): void {
  ledgers().clear();
}
