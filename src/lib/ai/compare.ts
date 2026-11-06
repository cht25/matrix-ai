// Shared validation for POST /api/ai/compare — kept pure so it is unit-tested.
import { isModelLane, type ModelLane } from "@/lib/ai/modes";

export const COMPARE_LANES: readonly ModelLane[] = ["fast", "balanced", "reasoning", "coding"];
export const MAX_COMPARE_LANES = 3;
export const MAX_COMPARE_MESSAGE = 4000;
export const DEFAULT_COMPARE_LANES: readonly ModelLane[] = ["fast", "balanced", "reasoning"];

/** Normalise a raw `lanes` array: valid lanes only, deduped, capped at 3. */
export function parseCompareLanes(value: unknown): ModelLane[] {
  const requested = Array.isArray(value) ? value.filter(isModelLane) : [...DEFAULT_COMPARE_LANES];
  const allowed = requested.filter((l): l is ModelLane => (COMPARE_LANES as readonly string[]).includes(l));
  return [...new Set(allowed)].slice(0, MAX_COMPARE_LANES);
}
