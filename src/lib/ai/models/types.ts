// Browser-safe model pool types (no credentials, no server imports).
import type { ModelStrength } from "@/lib/ai/models/registry";

export type ModelAvailability = "available" | "not_configured" | "not_offered" | "unverified";

export type ModelStatus = {
  key: string;
  label: string;
  summary: string;
  /** Real provider configuration — shown in Model settings only. */
  model_id: string;
  provider: string;
  availability: ModelAvailability;
  reason: string;
  is_default: boolean;
  strengths: ModelStrength[];
  context_tokens: number;
  max_output_tokens: number;
  streaming: boolean;
  tool_calling: boolean;
  structured_output: boolean;
};

export type PoolPreference = { auto: boolean; enabled: string[] };

export const STRENGTH_LABEL: Record<ModelStrength, string> = {
  planning: "Planning",
  coding: "Code",
  review: "Review",
  reasoning: "Reasoning",
  research: "Research",
  writing: "Writing",
  fast: "Fast",
};
