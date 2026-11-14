/** A legacy global explicit preference remains valid in both modes until
 * either mode gets its own override; explicit empty Agent override resets Auto. */
export type ModelPreference = { provider_id: string; model_id: string };
export function preferenceForMode(settings: Record<string, unknown> | undefined, mode: "chat" | "agent"): ModelPreference {
  const prefix = mode === "agent" ? "agent_ai" : "chat_ai";
  const hasSpecific = Object.prototype.hasOwnProperty.call(settings ?? {}, `${prefix}_model_id`);
  return {
    provider_id: String(hasSpecific ? settings?.[`${prefix}_provider_id`] ?? "" : settings?.ai_provider_id ?? ""),
    model_id: String(hasSpecific ? settings?.[`${prefix}_model_id`] ?? "" : settings?.ai_model_id ?? ""),
  };
}
