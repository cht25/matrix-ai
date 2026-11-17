// Browser-safe model pool types (no credentials, no server imports).
import type { ModelStrength } from "@/lib/ai/models/registry";

export type ModelAvailability = "available" | "not_configured" | "not_offered" | "unverified";

export type ModelProbeState =
  | "available"
  | "testing"
  | "unavailable"
  | "configuration_missing"
  | "temporarily_unavailable"
  | "rate_limited"
  | "invalid_credentials"
  | "permission_denied"
  | "model_not_found"
  | "out_of_capacity"
  | "unavailable_for_account";

export type ModelDiagnosticError = {
  code: string;
  message: string;
  status: number | null;
  at: string;
};

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
  /** Fine-grained runtime state for UI badges and admin diagnostics. */
  status_code: ModelProbeState;
  status_label: string;
  supported_modes: string[];
  last_tested_at: string | null;
  last_error: ModelDiagnosticError | null;
  diagnostic_hint: string | null;
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

export const PROBE_STATE_LABEL: Record<ModelProbeState, string> = {
  available: "Available",
  testing: "Testing",
  unavailable: "Unavailable",
  configuration_missing: "Requires configuration",
  temporarily_unavailable: "Temporarily unavailable",
  rate_limited: "Rate limited",
  invalid_credentials: "Invalid credentials",
  permission_denied: "Permission denied",
  model_not_found: "Model not found",
  out_of_capacity: "Out of capacity",
  unavailable_for_account: "Unavailable",
};
