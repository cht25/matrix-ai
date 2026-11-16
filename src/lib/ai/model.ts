// =============================================================================
// THE QORVYNA AI MODEL — single source of truth.
//
// QORVYNA runs on exactly one language model: GPT OSS 120B. Normal Chat, Agent
// mode, website generation, project editing, code generation and analysis,
// debugging, tool calling, planning, build/deploy assistance, research,
// comparison lanes and voice-transcript turns all resolve to the identifier
// below. There is no model selector, no per-mode model, no per-user model and
// no fallback to another model.
//
// Do not write this model ID anywhere else in the codebase — import it.
// (Speech-to-text and image generation are separate media services and are
// not language models; they are configured in their own modules.)
// =============================================================================

/** Provider-verified model ID, exactly as the Groq API lists it. */
export const QORVYNA_MODEL_ID = "openai/gpt-oss-120b";

/** Human-readable name shown in the UI. */
export const QORVYNA_MODEL_LABEL = "GPT OSS 120B";

/**
 * Who published the model. GPT OSS 120B is an open-weight model released by
 * OpenAI; QORVYNA did not create it, and reaches it through a hosting provider
 * (below) or a dedicated OpenAI-compatible endpoint the operator configures.
 */
export const QORVYNA_MODEL_PUBLISHER = "OpenAI" as const;

/** The hosted provider that serves the model. */
export const QORVYNA_MODEL_PROVIDER = "Groq" as const;
export const QORVYNA_MODEL_PROVIDER_ID = "groq" as const;
export const QORVYNA_MODEL_BASE_URL = "https://api.groq.com/openai/v1";

/** Public descriptor — safe to send to the browser (no credentials). */
export const QORVYNA_MODEL = {
  id: QORVYNA_MODEL_ID,
  label: QORVYNA_MODEL_LABEL,
  provider: QORVYNA_MODEL_PROVIDER,
  providerId: QORVYNA_MODEL_PROVIDER_ID,
  publisher: QORVYNA_MODEL_PUBLISHER,
  streaming: true,
  toolCalling: true,
  vision: false,
} as const;

/** True for any spelling of the one permitted model (hosts name it with or without the `openai/` prefix). */
export function isQorvynaModelId(value: string | null | undefined): boolean {
  return /^(?:openai\/)?gpt-oss-120b$/i.test((value ?? "").trim());
}

/**
 * Model ID to send to a self-hosted / dedicated OpenAI-compatible GPT OSS 120B
 * endpoint (`GPT_OSS_BASE_URL`). Such hosts may list the same model without
 * the vendor prefix, so `GPT_OSS_MODEL` may spell it either way — but it can
 * never name a different model.
 */
export function dedicatedEndpointModelId(configured: string | null | undefined): string {
  const value = (configured ?? "").trim();
  return isQorvynaModelId(value) ? value : QORVYNA_MODEL_ID;
}
