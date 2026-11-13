import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import { encryptSecret, decryptSecret, canEncryptSecrets } from "@/lib/ai/image/config";
import { fetchModelCatalog, type CatalogModel, type CatalogResult } from "@/lib/ai/model-catalog";
import { createOpenAICompatibleProvider, isCompatibleBaseUrl, normalizeCompatibleBaseUrl } from "@/lib/ai/openai";
import { GLMProvider, GLM_API_BASE_URL, resolveGlmBaseUrl } from "@/lib/ai/glm";
import { GeminiProvider, GEMINI_API_BASE_URL } from "@/lib/ai/gemini";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import type { AIProvider } from "@/lib/ai/groq";
import type { RegisteredProvider } from "@/lib/ai/provider-registry";
import type { AIProviderName } from "@/lib/ai/provider-error";
import { isProviderEndpointAllowed } from "@/lib/ai/endpoint-policy";
import { RpcError } from "@/lib/server/errors";

const COLLECTION = "system_settings";
const DOC_ID = "ai_managed_providers";
const MAX_PROVIDERS = 20;
const MAX_MODELS_PER_PROVIDER = 50;
const MAX_ACTIVE_ROUTES_PER_TASK = 20;
const PLACEHOLDERS = ["YOUR-", "replace-with", "...", "sk-...", "sk-or-v1-..."];

export type ManagedProviderKind = "glm" | "openai-compatible" | "gemini" | "anthropic";
export type ManagedModelConfig = {
  id: string;
  label: string;
  enabled: boolean;
  use_for_chat: boolean;
  use_for_agent: boolean;
  use_for_vision: boolean;
};
export type ManagedProviderPublic = {
  id: string;
  name: string;
  kind: ManagedProviderKind;
  base_url: string;
  enabled: boolean;
  api_key_set: boolean;
  api_key_last4: string;
  models: ManagedModelConfig[];
  updated_at: string;
};
export type ManagedProviderStored = Omit<ManagedProviderPublic, "api_key_set"> & {
  api_key_encrypted: string;
  updated_by: string;
};

/** In-memory form of the stored record; timestamps are ISO strings on disk. */
function nowIso(): string { return nowTs().toDate().toISOString(); }
export type ManagedProviderDraft = {
  id?: string;
  name: string;
  kind: ManagedProviderKind;
  base_url?: string;
  api_key?: string;
  enabled: boolean;
  models: ManagedModelConfig[];
  /** Skip the live catalog verification (explicit operator decision). */
  allow_unverified?: boolean;
};

function isKind(value: unknown): value is ManagedProviderKind {
  return value === "glm" || value === "openai-compatible" || value === "gemini" || value === "anthropic";
}
function keyConfigured(value: string): boolean {
  const key = value.trim();
  return Boolean(key) && !PLACEHOLDERS.some((placeholder) => key.includes(placeholder)) && !key.endsWith("...");
}
function nativeBaseUrl(kind: ManagedProviderKind): string {
  if (kind === "glm") return GLM_API_BASE_URL;
  if (kind === "gemini") return GEMINI_API_BASE_URL;
  if (kind === "anthropic") return "https://api.anthropic.com/v1";
  return "";
}
function normalizeBaseUrl(kind: ManagedProviderKind, value: string): string {
  if (kind === "glm") {
    const trimmed = value.trim();
    if (!trimmed) return resolveGlmBaseUrl();
    const normalizedGlm = normalizeCompatibleBaseUrl(trimmed);
    if (!normalizedGlm || !isCompatibleBaseUrl(normalizedGlm) || !isProviderEndpointAllowed(normalizedGlm)) {
      throw new RpcError("AI_MANAGED_PROVIDER_ENDPOINT_INVALID", 400);
    }
    return normalizedGlm;
  }
  if (kind !== "openai-compatible") return nativeBaseUrl(kind);
  const normalized = normalizeCompatibleBaseUrl(value);
  if (!normalized || !isCompatibleBaseUrl(normalized) || !isProviderEndpointAllowed(normalized)) {
    throw new RpcError("AI_MANAGED_PROVIDER_ENDPOINT_INVALID", 400);
  }
  return normalized;
}
function publicProvider(record: ManagedProviderStored): ManagedProviderPublic {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    base_url: record.base_url,
    enabled: record.enabled,
    api_key_set: Boolean(record.api_key_encrypted),
    api_key_last4: record.api_key_last4 ?? "",
    models: Array.isArray(record.models) ? record.models : [],
    updated_at: record.updated_at ?? "",
  };
}
function recordsFrom(value: unknown): ManagedProviderStored[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PROVIDERS).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string" || !isKind(item.kind) || typeof item.api_key_encrypted !== "string") return [];
    const models = Array.isArray(item.models) ? item.models.filter((model): model is ManagedModelConfig => {
      if (!model || typeof model !== "object") return false;
      const m = model as Record<string, unknown>;
      return typeof m.id === "string" && typeof m.label === "string";
    }).slice(0, MAX_MODELS_PER_PROVIDER).map((model) => ({
      id: model.id,
      label: model.label,
      enabled: model.enabled === true,
      use_for_chat: model.use_for_chat === true,
      use_for_agent: model.use_for_agent === true,
      use_for_vision: model.use_for_vision === true,
    })) : [];
    return [{
      id: item.id,
      name: item.name.slice(0, 80),
      kind: item.kind,
      base_url: typeof item.base_url === "string" ? item.base_url : nativeBaseUrl(item.kind),
      enabled: item.enabled === true,
      api_key_encrypted: item.api_key_encrypted,
      api_key_last4: typeof item.api_key_last4 === "string" ? item.api_key_last4 : "",
      models,
      updated_at: typeof item.updated_at === "string" ? item.updated_at : "",
      updated_by: typeof item.updated_by === "string" ? item.updated_by : "",
    }];
  });
}
async function readStored(d: Db): Promise<ManagedProviderStored[]> {
  const snap = await d.collection(COLLECTION).doc(DOC_ID).get();
  return recordsFrom(snap.exists ? snap.data()?.providers : []);
}
function createClient(kind: ManagedProviderKind, key: string, baseUrl: string, name: string, model = ""): AIProvider {
  if (kind === "glm") return new GLMProvider(key, baseUrl, model || undefined);
  if (kind === "gemini") return new GeminiProvider(key);
  if (kind === "anthropic") return new AnthropicProvider(key);
  return createOpenAICompatibleProvider({ apiKey: key, baseUrl, label: name, model });
}
function configError(code: string, status = 400): never {
  throw new RpcError(code, status);
}

export async function getManagedProvidersPublic(d: Db): Promise<ManagedProviderPublic[]> {
  return (await readStored(d)).map(publicProvider);
}

/** Fetch from the selected provider's real catalog; unsaved credentials are never persisted. */
export async function listManagedProviderModels(
  d: Db,
  input: { provider_id?: string; kind?: ManagedProviderKind; name?: string; base_url?: string; api_key?: string },
): Promise<CatalogResult> {
  let kind: ManagedProviderKind;
  let name: string;
  let baseUrl: string;
  let apiKey: string;
  if (input.provider_id) {
    const saved = (await readStored(d)).find((item) => item.id === input.provider_id);
    if (!saved) return configError("AI_MANAGED_PROVIDER_NOT_FOUND", 404);
    kind = input.kind ?? saved.kind;
    if (!isKind(kind)) return configError("AI_MANAGED_PROVIDER_KIND_INVALID");
    name = (input.name ?? saved.name).trim().slice(0, 80) || saved.name;
    baseUrl = normalizeBaseUrl(kind, input.base_url ?? saved.base_url);
    try { apiKey = input.api_key?.trim() || decryptSecret(saved.api_key_encrypted); } catch { return configError("SECRET_STORAGE_UNAVAILABLE", 503); }
  } else {
    if (!input.kind || !isKind(input.kind)) return configError("AI_MANAGED_PROVIDER_KIND_INVALID");
    kind = input.kind;
    name = (input.name ?? kind).trim().slice(0, 80) || kind;
    baseUrl = normalizeBaseUrl(kind, input.base_url ?? "");
    apiKey = input.api_key?.trim() ?? "";
  }
  if (!keyConfigured(apiKey)) return configError("AI_PROVIDER_API_KEY_REQUIRED");

  try {
    const client = createClient(kind, apiKey, baseUrl, name);
    const models = await client.listModels?.();
    if (!models?.length) return configError("AI_PROVIDER_CATALOG_FAILED", 502);
    return { models, verifiedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError("AI_PROVIDER_CATALOG_FAILED", 502);
  }
}

export async function saveManagedProvider(d: Db, updaterUid: string, input: ManagedProviderDraft): Promise<ManagedProviderPublic> {
  const name = input.name.trim().slice(0, 80);
  if (!name) return configError("AI_MANAGED_PROVIDER_NAME_INVALID");
  if (!isKind(input.kind)) return configError("AI_MANAGED_PROVIDER_KIND_INVALID");
  if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > MAX_MODELS_PER_PROVIDER) return configError("AI_MANAGED_PROVIDER_MODELS_INVALID");
  const baseUrl = normalizeBaseUrl(input.kind, input.base_url ?? "");
  const id = input.id?.trim() || randomUUID();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return configError("AI_MANAGED_PROVIDER_ID_INVALID");

  const existingRecords = await readStored(d);
  const existing = existingRecords.find((record) => record.id === id);
  if (input.id && !existing) return configError("AI_MANAGED_PROVIDER_NOT_FOUND", 404);
  const submittedKey = input.api_key?.trim() ?? "";
  let apiKey = submittedKey;
  if (!apiKey && existing && existing.kind === input.kind) {
    try { apiKey = decryptSecret(existing.api_key_encrypted); } catch { return configError("SECRET_STORAGE_UNAVAILABLE", 503); }
  }
  if (!keyConfigured(apiKey)) return configError("AI_PROVIDER_API_KEY_REQUIRED");
  if (!canEncryptSecrets()) return configError("SECRET_STORAGE_UNAVAILABLE", 503);

  const uniqueIds = new Set<string>();
  const requestedModels = input.models.map((model) => {
    const rawId = typeof model.id === "string" ? model.id.trim() : "";
    const modelId = input.kind === "gemini" ? rawId.replace(/^models\//, "") : rawId;
    if (!modelId || modelId.length > 220 || uniqueIds.has(modelId)) return configError("AI_MANAGED_PROVIDER_MODELS_INVALID");
    uniqueIds.add(modelId);
    return {
      id: modelId,
      label: String(model.label ?? modelId).trim().slice(0, 160) || modelId,
      enabled: model.enabled === true,
      use_for_chat: model.use_for_chat === true,
      use_for_agent: model.use_for_agent === true,
      use_for_vision: model.use_for_vision === true,
    };
  });

  // Verify every requested ID against the provider's real account catalog.
  // `allow_unverified` exists for endpoints that do not expose /models (some
  // Azure and gateway deployments); the operator takes explicit responsibility,
  // which is far better than a save that can never succeed.
  let models = requestedModels;
  if (input.allow_unverified !== true) {
    let catalog: CatalogModel[];
    try {
      const client = createClient(input.kind, apiKey, baseUrl, name);
      catalog = await client.listModels?.() ?? [];
    } catch {
      throw new RpcError("AI_PROVIDER_CATALOG_FAILED", 502);
    }
    if (!catalog.length) throw new RpcError("AI_PROVIDER_CATALOG_FAILED", 502);
    const catalogById = new Map(catalog.map((model) => [model.id, model]));
    models = requestedModels.map((model) => {
      const verified = catalogById.get(model.id);
      if (!verified) return configError("AI_MANAGED_MODEL_NOT_IN_CATALOG", 400);
      return { ...model, label: verified.label || model.label };
    });
  }

  const ref = d.collection(COLLECTION).doc(DOC_ID);
  const saved = await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = recordsFrom(snap.exists ? snap.data()?.providers : []);
    const previous = current.find((record) => record.id === id);
    if (input.id && !previous) return configError("AI_MANAGED_PROVIDER_NOT_FOUND", 404);
    // The catalog was checked outside the transaction. Refuse to overwrite a
    // provider edited in the meantime; the admin must reload and re-verify its
    // model selection against the latest endpoint/key.
    if (input.id && previous?.updated_at !== existing?.updated_at) return configError("AI_MANAGED_PROVIDER_CONFLICT", 409);
    let encryptedKey = previous?.api_key_encrypted ?? "";
    let last4 = previous?.api_key_last4 ?? "";
    if (submittedKey) {
      encryptedKey = encryptSecret(submittedKey);
      last4 = submittedKey.slice(-4);
    } else if (!encryptedKey) {
      return configError("AI_PROVIDER_API_KEY_REQUIRED");
    }
    const next: ManagedProviderStored = {
      id,
      name,
      kind: input.kind,
      base_url: baseUrl,
      enabled: input.enabled === true,
      api_key_encrypted: encryptedKey,
      api_key_last4: last4,
      models,
      updated_at: nowIso(),
      updated_by: updaterUid,
    };
    const index = current.findIndex((record) => record.id === id);
    if (index < 0 && current.length >= MAX_PROVIDERS) return configError("AI_MANAGED_PROVIDER_LIMIT", 400);
    const providers = [...current];
    if (index < 0) providers.push(next);
    else providers[index] = next;
    tx.set(ref, { providers, updated_by: updaterUid, updated_at: nowTs() }, { merge: true });
    return publicProvider(next);
  });
  return saved;
}

async function mutateProvider(
  d: Db,
  providerId: string,
  mutate: (providers: ManagedProviderStored[]) => ManagedProviderStored[],
): Promise<ManagedProviderPublic[]> {
  const ref = d.collection(COLLECTION).doc(DOC_ID);
  return d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = recordsFrom(snap.exists ? snap.data()?.providers : []);
    if (!current.some((provider) => provider.id === providerId)) return configError("AI_MANAGED_PROVIDER_NOT_FOUND", 404);
    const providers = mutate(current);
    tx.set(ref, { providers, updated_at: nowTs() }, { merge: true });
    return providers.map(publicProvider);
  });
}

export async function setManagedProviderEnabled(d: Db, providerId: string, enabled: boolean): Promise<ManagedProviderPublic[]> {
  return mutateProvider(d, providerId, (providers) => providers.map((provider) => provider.id === providerId ? { ...provider, enabled, updated_at: nowIso() } : provider));
}

export async function setManagedModelFlags(
  d: Db,
  input: { provider_id: string; model_id: string; enabled?: boolean; use_for_chat?: boolean; use_for_agent?: boolean; use_for_vision?: boolean },
): Promise<ManagedProviderPublic[]> {
  return mutateProvider(d, input.provider_id, (providers) => providers.map((provider) => {
    if (provider.id !== input.provider_id) return provider;
    const found = provider.models.some((model) => model.id === input.model_id);
    if (!found) return configError("AI_MANAGED_MODEL_NOT_FOUND", 404);
    return {
      ...provider,
      updated_at: nowIso(),
      models: provider.models.map((model) => model.id === input.model_id ? {
        ...model,
        ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
        ...(typeof input.use_for_chat === "boolean" ? { use_for_chat: input.use_for_chat } : {}),
        ...(typeof input.use_for_agent === "boolean" ? { use_for_agent: input.use_for_agent } : {}),
        ...(typeof input.use_for_vision === "boolean" ? { use_for_vision: input.use_for_vision } : {}),
      } : model),
    };
  }));
}

export async function deleteManagedProvider(d: Db, providerId: string): Promise<ManagedProviderPublic[]> {
  return mutateProvider(d, providerId, (providers) => providers.filter((provider) => provider.id !== providerId));
}

/** Catalog descriptors expose only models explicitly enabled by an administrator. */
export async function getManagedProviderCatalogEntries(d: Db | null): Promise<RegisteredProvider[]> {
  if (!d) return [];
  const entries: RegisteredProvider[] = [];
  for (const record of await readStored(d)) {
    if (!record.enabled) continue;
    const active = record.models.filter((model) => model.enabled && (model.use_for_chat || model.use_for_agent || model.use_for_vision));
    if (!active.length) continue;
    let apiKey = "";
    let baseUrl = "";
    try {
      apiKey = decryptSecret(record.api_key_encrypted);
      baseUrl = normalizeBaseUrl(record.kind, record.base_url);
    } catch { continue; }
    if (!keyConfigured(apiKey)) continue;
    const inner = createClient(record.kind, apiKey, baseUrl, record.name);
    const activeIds = new Set(active.map((model) => model.id));
    const client: AIProvider = {
      chat: (request) => inner.chat(request),
      ...(inner.streamChat ? { streamChat: (request) => inner.streamChat!(request) } : {}),
      healthCheck: (model) => inner.healthCheck(model),
      listModels: async () => {
        try {
          const live = (await inner.listModels?.() ?? []).filter((model) => activeIds.has(model.id));
          const seen = new Set(live.map((model) => model.id));
          const extras = active
            .filter((model) => !seen.has(model.id))
            .map((model) => ({ id: model.id, label: model.label || model.id }));
          return [...live, ...extras].sort((a, b) => a.id.localeCompare(b.id));
        } catch {
          return active.map((model) => ({ id: model.id, label: model.label || model.id })).sort((a, b) => a.id.localeCompare(b.id));
        }
      },
      supportsToolCalls: inner.supportsToolCalls,
    };
    entries.push({
      id: `managed-${record.id}`,
      name: record.name,
      client,
      baseUrl,
      defaultModel: active.find((model) => model.use_for_chat)?.id ?? "",
      codingModel: active.find((model) => model.use_for_agent)?.id ?? "",
      visionModel: active.find((model) => model.use_for_vision)?.id ?? "",
    });
  }
  return entries;
}

/** Enabled admin-managed routes in operator order. Keys never leave this server module. */
export async function getManagedProviderRoutes(d: Db | null, mode: "chat" | "agent" | "vision") {
  if (!d) return [];
  const records = await readStored(d);
  const routes: { provider: AIProviderName; model: string; client: AIProvider; providerId: string }[] = [];
  for (const record of records) {
    if (routes.length >= MAX_ACTIVE_ROUTES_PER_TASK) break;
    if (!record.enabled) continue;
    let apiKey = "";
    let baseUrl = "";
    try {
      apiKey = decryptSecret(record.api_key_encrypted);
      baseUrl = normalizeBaseUrl(record.kind, record.base_url);
    } catch { continue; }
    if (!keyConfigured(apiKey)) continue;
    for (const model of record.models) {
      if (routes.length >= MAX_ACTIVE_ROUTES_PER_TASK) break;
      if (!model.enabled || !model[`use_for_${mode}`]) continue;
      const client = createClient(record.kind, apiKey, baseUrl, record.name, model.id);
      routes.push({
        provider: record.kind === "glm" ? "GLM" : record.kind === "gemini" ? "Gemini" : record.kind === "anthropic" ? "Anthropic" : "OpenAI",
        model: model.id,
        client,
        providerId: record.id,
      });
    }
  }
  return routes;
}
