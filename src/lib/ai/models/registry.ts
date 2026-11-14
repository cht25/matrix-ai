// =============================================================================
// MATRIX model registry — the only place (with ./model.ts for the default)
// where language-model identifiers are written.
//
// What is and is not verified
//   • The identifiers below are the provider's published IDs. Whether a model
//     is actually offered to THIS deployment's account is never assumed: it is
//     checked against the provider's live model catalog at runtime
//     (src/lib/ai/models/pool.ts). A model that is not in the catalog is shown
//     as unavailable and is never sent a request.
//   • Context window: the catalog's reported value replaces the figure here
//     when the provider reports one.
//   • `tpm` is MATRIX's own conservative scheduling budget (tokens per minute
//     per server instance), not a claim about the account's quota. Override
//     with MATRIX_MODEL_TPM_<KEY> (e.g. MATRIX_MODEL_TPM_QWEN3_32B=12000). Real
//     provider rate-limit responses always take precedence (cool-down).
// =============================================================================

import { MATRIX_MODEL_ID, MATRIX_MODEL_LABEL } from "@/lib/ai/model";

/** What a model is good at. Drives which responsibility it is given. */
export type ModelStrength = "planning" | "coding" | "review" | "reasoning" | "research" | "writing" | "fast";

export type ModelSpec = {
  /** Stable key stored in user preferences (never the provider ID). */
  key: string;
  /** Provider model ID, exactly as the provider lists it. */
  id: string;
  /** Friendly name shown in Chat and Agent. */
  label: string;
  /** One-line plain description for the picker. */
  summary: string;
  provider: "groq";
  providerLabel: "Groq";
  contextTokens: number;
  maxOutputTokens: number;
  tpm: number;
  strengths: readonly ModelStrength[];
  /** How hidden reasoning is requested for this model family, if at all. */
  reasoning: "effort" | "format" | "none";
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  /** Lower = preferred coordinator (plans, reviews, writes the final answer). */
  coordinatorRank: number;
};

export const DEFAULT_MODEL_KEY = "gpt-oss-120b";

export const MODEL_REGISTRY: readonly ModelSpec[] = [
  {
    key: DEFAULT_MODEL_KEY, id: MATRIX_MODEL_ID, label: MATRIX_MODEL_LABEL, summary: "Strongest all-rounder for planning, code and careful answers.",
    provider: "groq", providerLabel: "Groq", contextTokens: 131_072, maxOutputTokens: 16_384, tpm: 30_000,
    strengths: ["planning", "coding", "reasoning", "review", "writing"], reasoning: "effort", streaming: true, toolCalling: true, structuredOutput: true, coordinatorRank: 1,
  },
  {
    key: "qwen3-32b", id: "qwen/qwen3-32b", label: "Qwen 3 32B", summary: "Step-by-step reasoning and code review.",
    provider: "groq", providerLabel: "Groq", contextTokens: 131_072, maxOutputTokens: 8_192, tpm: 12_000,
    strengths: ["reasoning", "coding", "review"], reasoning: "format", streaming: true, toolCalling: true, structuredOutput: true, coordinatorRank: 3,
  },
  {
    key: "llama-3.3-70b", id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", summary: "Clear writing, research summaries and second opinions.",
    provider: "groq", providerLabel: "Groq", contextTokens: 131_072, maxOutputTokens: 8_192, tpm: 12_000,
    strengths: ["writing", "research", "review", "coding"], reasoning: "none", streaming: true, toolCalling: true, structuredOutput: true, coordinatorRank: 2,
  },
  {
    key: "gpt-oss-20b", id: "openai/gpt-oss-20b", label: "GPT OSS 20B", summary: "Quick drafts and small code tasks.",
    provider: "groq", providerLabel: "Groq", contextTokens: 131_072, maxOutputTokens: 8_192, tpm: 12_000,
    strengths: ["fast", "coding", "planning"], reasoning: "effort", streaming: true, toolCalling: true, structuredOutput: true, coordinatorRank: 4,
  },
  {
    key: "llama-3.1-8b", id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", summary: "Very fast checks and short summaries.",
    provider: "groq", providerLabel: "Groq", contextTokens: 131_072, maxOutputTokens: 8_192, tpm: 6_000,
    strengths: ["fast", "writing"], reasoning: "none", streaming: true, toolCalling: true, structuredOutput: true, coordinatorRank: 5,
  },
];

const BY_KEY = new Map(MODEL_REGISTRY.map((spec) => [spec.key, spec]));
const normalizeId = (id: string) => id.trim().toLowerCase().replace(/^openai\//, "");
const BY_ID = new Map(MODEL_REGISTRY.map((spec) => [normalizeId(spec.id), spec]));

export function modelByKey(key: string | null | undefined): ModelSpec | null {
  return BY_KEY.get((key ?? "").trim()) ?? null;
}
/** Matches the provider ID (a dedicated host may omit the vendor prefix). */
export function modelById(id: string | null | undefined): ModelSpec | null {
  return BY_ID.get(normalizeId(id ?? "")) ?? null;
}
export function isRegisteredModelId(id: string | null | undefined): boolean {
  return modelById(id) !== null;
}
export function defaultModel(): ModelSpec {
  return BY_KEY.get(DEFAULT_MODEL_KEY)!;
}
/** Friendly label for a provider ID; unknown IDs are returned unchanged. */
export function modelLabel(id: string): string {
  return modelById(id)?.label ?? id;
}
/** Keep only known keys, de-duplicated, in registry order. */
export function sanitizeModelKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.map(String));
  return MODEL_REGISTRY.filter((spec) => wanted.has(spec.key)).map((spec) => spec.key);
}
/** Scheduling budget, with the optional per-deployment override. */
export function modelTpm(spec: ModelSpec, env: Record<string, string | undefined> = process.env): number {
  const override = Number(env[`MATRIX_MODEL_TPM_${spec.key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`]);
  return Number.isFinite(override) && override >= 1000 ? Math.floor(override) : spec.tpm;
}
