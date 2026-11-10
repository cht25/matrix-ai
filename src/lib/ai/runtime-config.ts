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
import { FieldValue } from "firebase-admin/firestore";
import { encryptSecret, decryptSecret, canEncryptSecrets } from "@/lib/ai/image/config";
import { Db, nowTs } from "@/lib/firebase/admin";
import { fetchModelCatalog, verifyCatalogModel, type CatalogResult } from "@/lib/ai/model-catalog";
import { isProviderEndpointAllowed } from "@/lib/ai/endpoint-policy";
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
  /** Optional separate model ID for Agent/coding requests. Falls back to `model` when blank. */
  agent_model?: string;
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
  agent_model: string;
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
  const record = snap.exists ? (snap.data() ?? {}) : {};
  // Read legacy plaintext records without breaking existing deployments; the
  // next approved save encrypts and removes the legacy field.
  const apiKey = typeof record.api_key_encrypted === "string" ? decryptSecret(record.api_key_encrypted) : typeof record.api_key === "string" ? record.api_key : "";
  return { ...record, api_key: apiKey };
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
    agent_model: typeof record.agent_model === "string" ? record.agent_model.trim() : "",
    api_key: apiKey,
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : "OpenAI-compatible",
    updated_by: typeof record.updated_by === "string" ? record.updated_by : "",
    updated_at: record.updated_at,
  };
}

function clientFor(config: StoredAIProviderConfig, model = config.model): AIProvider {
  return createOpenAICompatibleProvider({
    apiKey: config.api_key,
    baseUrl: config.base_url,
    label: config.label,
    // The honest health probe runs a one-token completion against THIS model.
    model,
  });
}

export function createRuntimeAIRoute(config: StoredAIProviderConfig | null): RuntimeAIRoute | null {
  if (!config || !config.enabled) return null;
  return {
    provider: "OpenAI",
    model: config.model,
    client: clientFor(config),
  };
}

/**
 * Route for Agent / coding requests. Uses the dedicated Agent model when one
 * is saved, otherwise the shared chat model. The client is constructed lazily
 * so a bad Agent model ID never affects general chat.
 */
export function createRuntimeAgentRoute(config: StoredAIProviderConfig | null): RuntimeAIRoute | null {
  if (!config || !config.enabled) return null;
  return {
    provider: "OpenAI",
    model: config.agent_model?.trim() || config.model,
    client: clientFor(config, config.agent_model?.trim() || config.model),
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
    agent_model: typeof record.agent_model === "string" ? record.agent_model.trim() : "",
    api_key_set: configured,
    api_key_last4: configured ? apiKey.slice(-4) : "",
    updated_by: typeof record.updated_by === "string" ? record.updated_by : "",
    updated_at: asIso(record.updated_at),
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : "OpenAI-compatible",
  };
}

/** Fetch model IDs from the admin-selected endpoint without persisting a draft key. */
export async function listAIProviderModels(
  d: Db,
  input: { base_url: string; api_key?: string },
): Promise<CatalogResult> {
  const baseUrl = normalizeCompatibleBaseUrl(input.base_url);
  if (!baseUrl || !isCompatibleBaseUrl(baseUrl) || !isProviderEndpointAllowed(baseUrl)) {
    throw new RpcError("AI_PROVIDER_BASE_URL_INVALID", 400);
  }

  const record = await readRecord(d);
  const suppliedKey = input.api_key?.trim() ?? "";
  const apiKey = suppliedKey || (typeof record.api_key === "string" ? record.api_key : "");
  if (!keyConfigured(apiKey)) throw new RpcError("AI_PROVIDER_API_KEY_REQUIRED", 400);

  try {
    return await fetchModelCatalog({ baseUrl, apiKey, provider: "OpenAI", refresh: true });
  } catch {
    // Provider errors can contain request details; return a stable code and
    // keep the credentials/draft endpoint out of the RPC response and logs.
    throw new RpcError("AI_PROVIDER_CATALOG_FAILED", 502);
  }
}

export async function saveAIProviderConfig(
  d: Db,
  updaterUid: string,
  input: { base_url: string; model: string; agent_model?: string; api_key?: string; enabled?: boolean; label?: string },
): Promise<PublicAIProviderConfig> {
  const normalizedBase = normalizeCompatibleBaseUrl(input.base_url);
  if (!normalizedBase || !isCompatibleBaseUrl(normalizedBase) || !isProviderEndpointAllowed(normalizedBase)) {
    throw new RpcError("AI_PROVIDER_BASE_URL_INVALID", 400);
  }
  const model = input.model.trim();
  if (!model || model.length > 220) {
    throw new RpcError("AI_PROVIDER_MODEL_INVALID", 400);
  }
  // Blank = "use the chat model for Agent too". A value must be a sane model ID.
  const agentModel = (input.agent_model ?? "").trim();
  if (agentModel.length > 220) {
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
  if (!canEncryptSecrets()) throw new RpcError("SECRET_STORAGE_UNAVAILABLE", 503);

  // Validate the NEW IDs against the configured account before replacing a
  // working configuration. A catalog never invents a replacement model.
  for (const id of new Set([model, ...(agentModel ? [agentModel] : [])])) {
    try {
      await verifyCatalogModel({ baseUrl: normalizedBase, apiKey, refresh: true }, id);
    } catch (error) {
      throw new RpcError(error instanceof Error ? error.message.slice(0, 300) : "AI_PROVIDER_MODEL_INVALID", 400);
    }
  }

  await d.collection(COLLECTION).doc(DOC_ID).set(
    {
      enabled: input.enabled !== false,
      base_url: normalizedBase,
      model,
      agent_model: agentModel,
      label,
      api_key_encrypted: encryptSecret(apiKey),
      api_key_last4: apiKey.slice(-4),
      api_key: FieldValue.delete(),
      updated_by: updaterUid,
      updated_at: nowTs(),
    },
    { merge: true },
  );

  return getAIProviderConfigPublic(d);
}

export async function testAIProviderConfig(d: Db, mode: "general" | "agent" = "general"): Promise<{ ok: boolean; provider: AIProviderName; model: string; base_url: string; mode: "general" | "agent"; detail: string }> {
  const config = await readAIProviderConfig(d);
  const route = mode === "agent" ? createRuntimeAgentRoute(config) : createRuntimeAIRoute(config);
  if (!route) throw new RpcError("AI_PROVIDER_NOT_CONFIGURED", 400);
  const ok = await route.client.healthCheck(route.model);
  return {
    ok,
    provider: route.provider,
    model: route.model,
    base_url: config?.base_url ?? "",
    mode,
    detail: ok
      ? `The endpoint answered a live ${mode === "agent" ? "Agent" : "chat"} model check (${route.model}).`
      : `The endpoint did not pass the live check for model "${route.model}". Confirm the base URL points at an OpenAI-compatible /models endpoint and that the key and model ID are correct.`,
  };
}
