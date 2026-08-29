// =============================================================================
// Admin-configurable OpenAI-compatible AI provider settings.
//
// Values live in Firestore under `system_settings/ai_provider` so the admin can
// change the endpoint, model and API key from the Admin panel without a code
// deploy. The server Admin SDK always enforces `system.settings` RBAC before
// returning or mutating these settings, and the raw API key is never returned
// to the browser — only a masked "configured" status plus the last four digits.
//
// If nothing is saved here (or the record is disabled), the AI gateway falls
// back to the existing environment-keyed providers (Groq / OpenRouter) so a
// database outage can never silently take the whole assistant offline.
// =============================================================================

import "server-only";
import { Db, nowTs } from "@/lib/firebase/admin";
import { RpcError } from "@/lib/server/errors";
import type { AIProvider } from "@/lib/ai/groq";
import { createOpenAICompatibleProvider, isCompatibleBaseUrl, normalizeCompatibleBaseUrl } from "@/lib/ai/openai";
import type { AIProviderName } from "@/lib/ai/provider-error";

const COLLECTION = "system_settings";
const DOC_ID = "ai_provider";

export type RuntimeAIRoute = {
  provider: AIProviderName;
  model: string;
  client: AIProvider;
};

export type StoredAIProviderConfig = {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key: string;
  label?: string;
  updated_by?: string;
  updated_at?: unknown;
};

export type PublicAIProviderConfig = {
  configured: boolean;
  enabled: boolean;
  base_url: string;
  model: string;
  api_key_set: boolean;
  api_key_last4: string;
  updated_by: string;
  updated_at: string;
  label: string;
};

const PLACEHOLDERS = ["YOUR-", "replace-with", "...", "sk-...", "sk-or-v1-..."];

function keyConfigured(value: unknown): boolean {
  const normalized = typeof value === "string" ? value.trim() : "";
  return Boolean(normalized) && !PLACEHOLDERS.some((p) => normalized.includes(p)) && !normalized.endsWith("...");
}

function asIso(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const ts = value as { toDate?: () => Date; toMillis?: () => number };
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (typeof ts.toMillis === "function") return new Date(ts.toMillis()).toISOString();
  return "";
}

async function readRecord(d: Db): Promise<Record<string, unknown>> {
  const snap = await d.collection(COLLECTION).doc(DOC_ID).get();
  return snap.exists ? (snap.data() ?? {}) : {};
}

/**
 * Read the saved admin provider record. Returns `null` when nothing usable has
 * been saved yet; the caller should then use the environment fallback.
 */
export async function readAIProviderConfig(d: Db): Promise<StoredAIProviderConfig | null> {
  const record = await readRecord(d);
  const baseUrl = normalizeCompatibleBaseUrl(typeof record.base_url === "string" ? record.base_url : "");
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const apiKey = typeof record.api_key === "string" ? record.api_key : "";
  if (!baseUrl || !model || !keyConfigured(apiKey)) return null;
  return {
    enabled: record.enabled !== false,
    base_url: baseUrl,
    model,
    api_key: apiKey,
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : "OpenAI-compatible",
    updated_by: typeof record.updated_by === "string" ? record.updated_by : "",
    updated_at: record.updated_at,
  };
}

export function createRuntimeAIRoute(config: StoredAIProviderConfig | null): RuntimeAIRoute | null {
  if (!config || !config.enabled) return null;
  return {
    provider: "OpenAI",
    model: config.model,
    client: createOpenAICompatibleProvider({
      apiKey: config.api_key,
      baseUrl: config.base_url,
      label: config.label,
    }),
  };
}

export async function getAIProviderConfigPublic(d: Db): Promise<PublicAIProviderConfig> {
  const record = await readRecord(d);
  const baseUrl = normalizeCompatibleBaseUrl(typeof record.base_url === "string" ? record.base_url : "");
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const apiKey = typeof record.api_key === "string" ? record.api_key : "";
  const configured = Boolean(baseUrl && model && keyConfigured(apiKey));
  return {
    configured,
    enabled: record.enabled !== false,
    base_url: baseUrl,
    model,
    api_key_set: configured,
    api_key_last4: configured ? apiKey.slice(-4) : "",
    updated_by: typeof record.updated_by === "string" ? record.updated_by : "",
    updated_at: asIso(record.updated_at),
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : "OpenAI-compatible",
  };
}

export async function saveAIProviderConfig(
  d: Db,
  updaterUid: string,
  input: { base_url: string; model: string; api_key?: string; enabled?: boolean; label?: string },
): Promise<PublicAIProviderConfig> {
  const normalizedBase = normalizeCompatibleBaseUrl(input.base_url);
  if (!normalizedBase || !isCompatibleBaseUrl(normalizedBase)) {
    throw new RpcError("AI_PROVIDER_BASE_URL_INVALID", 400);
  }
  const model = input.model.trim();
  if (!model || model.length > 220) {
    throw new RpcError("AI_PROVIDER_MODEL_INVALID", 400);
  }
  const label = input.label?.trim().slice(0, 80) || "OpenAI-compatible";

  const current = await readRecord(d);
  const existingKey = typeof current.api_key === "string" ? current.api_key : "";
  const newKey = input.api_key?.trim() ?? "";
  const apiKey = newKey || existingKey;
  if (!keyConfigured(apiKey)) {
    throw new RpcError("AI_PROVIDER_API_KEY_REQUIRED", 400);
  }

  await d.collection(COLLECTION).doc(DOC_ID).set(
    {
      enabled: input.enabled !== false,
      base_url: normalizedBase,
      model,
      label,
      api_key: apiKey,
      updated_by: updaterUid,
      updated_at: nowTs(),
    },
    { merge: true },
  );

  return getAIProviderConfigPublic(d);
}

export async function testAIProviderConfig(d: Db): Promise<{ ok: boolean; provider: AIProviderName; model: string; base_url: string; detail: string }> {
  const config = await readAIProviderConfig(d);
  const route = createRuntimeAIRoute(config);
  if (!route) throw new RpcError("AI_PROVIDER_NOT_CONFIGURED", 400);
  const ok = await route.client.healthCheck();
  return {
    ok,
    provider: route.provider,
    model: route.model,
    base_url: config?.base_url ?? "",
    detail: ok
      ? "The endpoint answered a live provider check."
      : "The endpoint did not pass the live check. Confirm the base URL points at an OpenAI-compatible /models endpoint and that the key/model are correct.",
  };
}
