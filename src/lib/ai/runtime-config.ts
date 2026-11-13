// =============================================================================
// Mutable main-model configuration (server-only).
//
// The MAIN model of MATRIX is an admin-editable record stored in Firestore
// (`system_settings/ai_provider`). Shipped architecture:
//
//   High-load / Coding / Web Dev / Agent / Vision → GLM (Zhipu AI / Z.ai)
//   Low-load / Fast everyday tasks               → openai/gpt-oss-120b
//
// Operators can customize the primary model, low-load model, or point the
// gateway at any OpenAI-compatible, Anthropic, or optional secondary provider
// from Admin → AI configuration while keeping all managed models active.
// =============================================================================

import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { encryptSecret, decryptSecret, canEncryptSecrets } from "@/lib/ai/image/config";
import { Db, nowTs } from "@/lib/firebase/admin";
import { verifyProviderModel, listProviderModels, type CatalogResult } from "@/lib/ai/model-catalog";
import { isProviderEndpointAllowed } from "@/lib/ai/endpoint-policy";
import { RpcError } from "@/lib/server/errors";
import type { AIProvider } from "@/lib/ai/groq";
import { GPT_OSS_DEFAULT_MODEL } from "@/lib/ai/groq";
import {
  GLMProvider,
  GLM_DEFAULT_CODING_MODEL,
  GLM_DEFAULT_MODEL,
  GLM_DEFAULT_VISION_MODEL,
  GLM_KNOWN_MODELS,
  resolveGlmBaseUrl,
} from "@/lib/ai/glm";
import { createOpenAICompatibleProvider, isCompatibleBaseUrl, normalizeCompatibleBaseUrl } from "@/lib/ai/openai";
import type { AIProviderName } from "@/lib/ai/provider-error";
import { GeminiProvider, GEMINI_API_BASE_URL, GEMINI_DEFAULT_MODEL } from "@/lib/ai/gemini";
import { AnthropicProvider, ANTHROPIC_API_BASE_URL } from "@/lib/ai/anthropic";

const COLLECTION = "system_settings";
const DOC_ID = "ai_provider";

export const MAIN_MODEL_KINDS = ["glm", "openai-compatible", "anthropic", "gemini"] as const;
export type MainModelKind = (typeof MAIN_MODEL_KINDS)[number];

export function isMainModelKind(value: unknown): value is MainModelKind {
  return typeof value === "string" && (MAIN_MODEL_KINDS as readonly string[]).includes(value);
}

/** Fixed or default base URL per protocol adapter. */
export function nativeBaseUrl(kind: MainModelKind): string {
  if (kind === "glm") return resolveGlmBaseUrl();
  if (kind === "gemini") return GEMINI_API_BASE_URL;
  if (kind === "anthropic") return ANTHROPIC_API_BASE_URL;
  return "";
}

export function providerNameFor(kind: MainModelKind): AIProviderName {
  if (kind === "glm") return "GLM";
  if (kind === "gemini") return "Gemini";
  if (kind === "anthropic") return "Anthropic";
  return "OpenAI";
}

/** Model IDs suggested for quick selection in Admin → AI configuration. */
export const SUGGESTED_MODELS: Record<MainModelKind, string[]> = {
  glm: GLM_KNOWN_MODELS.map((m) => m.id),
  "openai-compatible": [GPT_OSS_DEFAULT_MODEL],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1"],
  gemini: [GEMINI_DEFAULT_MODEL, "gemini-2.5-pro"],
};

export type RuntimeAIRoute = {
  provider: AIProviderName;
  model: string;
  client: AIProvider;
  kind: MainModelKind;
};

export type StoredAIProviderConfig = {
  kind?: MainModelKind;
  enabled: boolean;
  base_url: string;
  model: string;
  /** Optional separate model ID for Agent/coding/web-dev requests. Falls back to `model` when blank. */
  agent_model?: string;
  /** Optional dedicated multimodal model. Falls back to `model` when blank. */
  vision_model?: string;
  /** Optional low-load fast model override (defaults to `openai/gpt-oss-120b`). */
  low_task_model?: string;
  api_key: string;
  label?: string;
  source?: "database" | "environment";
  updated_by?: string;
  updated_at?: unknown;
};

export type PublicAIProviderConfig = {
  configured: boolean;
  enabled: boolean;
  kind: MainModelKind;
  kind_label: string;
  base_url: string;
  model: string;
  agent_model: string;
  vision_model: string;
  low_task_model: string;
  api_key_set: boolean;
  api_key_last4: string;
  updated_by: string;
  updated_at: string;
  label: string;
  suggested_models: string[];
  /** True when the environment (GLM_API_KEY etc.) supplies a key instead. */
  environment_key: boolean;
  source: "database" | "environment" | "none";
};

const KIND_LABEL: Record<MainModelKind, string> = {
  glm: "GLM (Zhipu AI / Z.ai)",
  "openai-compatible": "OpenAI-compatible endpoint",
  anthropic: "Anthropic Claude API",
  gemini: "Google Gemini API (optional)",
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

/** Environment fallback credentials, per provider kind. */
export function environmentKeyFor(kind: MainModelKind): string {
  if (kind === "glm") return keyConfigured(process.env.ZAI_API_KEY) ? process.env.ZAI_API_KEY!.trim() : keyConfigured(process.env.GLM_API_KEY) ? process.env.GLM_API_KEY!.trim() : "";
  if (kind === "anthropic") return keyConfigured(process.env.ANTHROPIC_API_KEY) ? process.env.ANTHROPIC_API_KEY!.trim() : "";
  if (kind === "gemini") return keyConfigured(process.env.GEMINI_API_KEY) ? process.env.GEMINI_API_KEY!.trim() : "";
  return keyConfigured(process.env.OPENAI_API_KEY) ? process.env.OPENAI_API_KEY!.trim() : "";
}

function environmentModelFor(kind: MainModelKind): string {
  if (kind === "glm") return process.env.GLM_MODEL?.trim() || GLM_DEFAULT_MODEL;
  if (kind === "anthropic") return process.env.ANTHROPIC_MODEL?.trim() || "";
  if (kind === "gemini") return process.env.GEMINI_MODEL?.trim() || "";
  return process.env.OPENAI_MODEL?.trim() || "";
}

async function readRecord(d: Db): Promise<Record<string, unknown>> {
  const snap = await d.collection(COLLECTION).doc(DOC_ID).get();
  const record = snap.exists ? (snap.data() ?? {}) : {};
  const apiKey = typeof record.api_key_encrypted === "string"
    ? decryptSecret(record.api_key_encrypted)
    : typeof record.api_key === "string" ? record.api_key : "";
  return { ...record, api_key: apiKey };
}

function storedKind(record: Record<string, unknown>): MainModelKind {
  if (record.kind === "glm" || record.kind === "gemini" || record.kind === "anthropic" || record.kind === "openai-compatible") {
    return record.kind;
  }
  // Legacy records created before `kind` existed had `base_url` or `api_key`
  // without `kind` and pointed at an OpenAI-compatible endpoint. An empty
  // unsaved record defaults to GLM — the primary high-end/coding system.
  const hasLegacyFields = Boolean(
    (typeof record.base_url === "string" && record.base_url.trim()) ||
    (typeof record.api_key === "string" && record.api_key.trim()) ||
    (typeof record.api_key_encrypted === "string" && record.api_key_encrypted.trim()),
  );
  if (/^https:\/\/(?:api\.z\.ai|open\.bigmodel\.cn)\//i.test(String(record.base_url ?? ""))) return "glm";
  return hasLegacyFields ? "openai-compatible" : "glm";
}

function inferInputKind(input: { kind?: string; base_url?: string }, fallbackRecord: Record<string, unknown>): MainModelKind {
  if (isMainModelKind(input.kind)) return input.kind;
  const suppliedUrl = input.base_url?.trim() ?? "";
  if (/^https:\/\/(?:api\.z\.ai|open\.bigmodel\.cn)\//i.test(suppliedUrl)) return "glm";
  if (suppliedUrl && suppliedUrl !== GEMINI_API_BASE_URL && suppliedUrl !== ANTHROPIC_API_BASE_URL) {
    return "openai-compatible";
  }
  return storedKind(fallbackRecord);
}

function normalizeBase(kind: MainModelKind, value: string): string {
  if (kind === "glm") {
    const trimmed = value.trim();
    return trimmed ? normalizeCompatibleBaseUrl(trimmed) : resolveGlmBaseUrl();
  }
  if (kind !== "openai-compatible") return nativeBaseUrl(kind);
  return normalizeCompatibleBaseUrl(value);
}

/**
 * Read the saved main-model record. Returns `null` when nothing usable has been
 * saved yet; the caller then uses the environment GLM / provider configuration.
 */
export async function readAIProviderConfig(d: Db): Promise<StoredAIProviderConfig | null> {
  const record = await readRecord(d);
  const kind = storedKind(record);
  const baseUrl = normalizeBase(kind, typeof record.base_url === "string" ? record.base_url : "");
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const apiKey = typeof record.api_key === "string" ? record.api_key : "";
  if (!baseUrl || !model || !keyConfigured(apiKey)) return null;
  return {
    kind,
    enabled: record.enabled !== false,
    base_url: baseUrl,
    model,
    agent_model: typeof record.agent_model === "string" ? record.agent_model.trim() : "",
    vision_model: typeof record.vision_model === "string" ? record.vision_model.trim() : "",
    low_task_model: typeof record.low_task_model === "string" ? record.low_task_model.trim() : "",
    api_key: apiKey,
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : KIND_LABEL[kind],
    source: "database",
    updated_by: typeof record.updated_by === "string" ? record.updated_by : "",
    updated_at: record.updated_at,
  };
}

/**
 * The main-model configuration actually in force right now.
 *
 * Order: the admin-saved Firestore record → the environment (`GLM_API_KEY`,
 * then `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`). Gemini is intentionally NOT
 * part of automatic environment promotion; GLM is the primary system.
 */
export async function resolveMainModelConfig(d: Db | null): Promise<StoredAIProviderConfig | null> {
  if (d) {
    try {
      const saved = await readAIProviderConfig(d);
      if (saved) return saved;
    } catch {
      // A Firestore outage must not take the assistant offline when the
      // environment carries a working GLM / provider key.
    }
  }
  for (const kind of ["glm", "openai-compatible", "anthropic"] as MainModelKind[]) {
    const apiKey = environmentKeyFor(kind);
    if (!apiKey) continue;
    const model = environmentModelFor(kind);
    if (!model) continue;
    const baseUrl = kind === "glm"
      ? resolveGlmBaseUrl(process.env.GLM_BASE_URL)
      : kind === "openai-compatible"
        ? normalizeCompatibleBaseUrl(process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1")
        : nativeBaseUrl(kind);
    if (!baseUrl || !isProviderEndpointAllowed(baseUrl)) continue;
    return {
      kind,
      enabled: true,
      base_url: baseUrl,
      model,
      agent_model: kind === "glm" ? (process.env.GLM_CODING_MODEL?.trim() || GLM_DEFAULT_CODING_MODEL) : "",
      vision_model: kind === "glm" ? (process.env.GLM_VISION_MODEL?.trim() || GLM_DEFAULT_VISION_MODEL) : "",
      low_task_model: process.env.GPT_OSS_MODEL?.trim() || process.env.GROQ_CHAT_MODEL?.trim() || GPT_OSS_DEFAULT_MODEL,
      api_key: apiKey,
      label: `${KIND_LABEL[kind]} (environment)`,
      source: "environment",
      updated_by: "",
      updated_at: "",
    };
  }
  return null;
}

export function createClientFor(kind: MainModelKind, apiKey: string, baseUrl: string, label: string, model = ""): AIProvider {
  if (kind === "glm") return new GLMProvider(apiKey, baseUrl || resolveGlmBaseUrl(), model || GLM_DEFAULT_MODEL);
  if (kind === "gemini") return new GeminiProvider(apiKey, baseUrl || GEMINI_API_BASE_URL);
  if (kind === "anthropic") return new AnthropicProvider(apiKey, baseUrl || ANTHROPIC_API_BASE_URL);
  return createOpenAICompatibleProvider({ apiKey, baseUrl, label, model });
}

function routeFor(config: StoredAIProviderConfig, model: string): RuntimeAIRoute {
  const kind = config.kind ?? "openai-compatible";
  return {
    provider: providerNameFor(kind),
    model,
    kind,
    client: createClientFor(kind, config.api_key, config.base_url, config.label || KIND_LABEL[kind], model),
  };
}

export function createRuntimeAIRoute(config: StoredAIProviderConfig | null): RuntimeAIRoute | null {
  if (!config || !config.enabled || !config.model) return null;
  return routeFor(config, config.model);
}

/**
 * Route for Agent / coding / web-dev requests. Uses the dedicated Agent model
 * when one is saved, otherwise the shared high-end model.
 */
export function createRuntimeAgentRoute(config: StoredAIProviderConfig | null): RuntimeAIRoute | null {
  if (!config || !config.enabled) return null;
  return routeFor(config, config.agent_model?.trim() || config.model);
}

/** Route for screenshots / vision. Falls back to GLM vision or the chat model. */
export function createRuntimeVisionRoute(config: StoredAIProviderConfig | null): RuntimeAIRoute | null {
  if (!config || !config.enabled) return null;
  const fallbackVision = config.kind === "glm" ? GLM_DEFAULT_VISION_MODEL : config.model;
  return routeFor(config, config.vision_model?.trim() || fallbackVision);
}

export async function getAIProviderConfigPublic(d: Db): Promise<PublicAIProviderConfig> {
  const record = await readRecord(d);
  const savedKind = storedKind(record);
  const savedBaseUrl = normalizeBase(savedKind, typeof record.base_url === "string" ? record.base_url : "");
  const savedModel = typeof record.model === "string" ? record.model.trim() : "";
  const apiKey = typeof record.api_key === "string" ? record.api_key : "";
  const configured = Boolean(savedBaseUrl && savedModel && keyConfigured(apiKey));
  const envFallback = !configured ? await resolveMainModelConfig(null) : null;
  const kind = configured ? savedKind : envFallback?.kind ?? savedKind;
  const baseUrl = configured ? savedBaseUrl : envFallback?.base_url ?? savedBaseUrl;
  const envKey = !configured ? environmentKeyFor(kind) : "";
  return {
    configured: configured || Boolean(envKey),
    enabled: record.enabled !== false,
    kind,
    kind_label: KIND_LABEL[kind],
    base_url: baseUrl || nativeBaseUrl(kind),
    model: savedModel || envFallback?.model || (envKey ? environmentModelFor(kind) : GLM_DEFAULT_MODEL),
    agent_model: typeof record.agent_model === "string" && record.agent_model.trim() ? record.agent_model.trim() : envFallback?.agent_model ?? (kind === "glm" ? GLM_DEFAULT_CODING_MODEL : ""),
    vision_model: typeof record.vision_model === "string" && record.vision_model.trim() ? record.vision_model.trim() : envFallback?.vision_model ?? (kind === "glm" ? GLM_DEFAULT_VISION_MODEL : ""),
    low_task_model: typeof record.low_task_model === "string" && record.low_task_model.trim()
      ? record.low_task_model.trim()
      : (process.env.GPT_OSS_MODEL?.trim() || process.env.GROQ_CHAT_MODEL?.trim() || GPT_OSS_DEFAULT_MODEL),
    api_key_set: configured,
    api_key_last4: configured ? apiKey.slice(-4) : envKey ? envKey.slice(-4) : "",
    updated_by: typeof record.updated_by === "string" ? record.updated_by : "",
    updated_at: asIso(record.updated_at),
    label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : KIND_LABEL[kind],
    suggested_models: SUGGESTED_MODELS[kind],
    environment_key: Boolean(envKey),
    source: configured ? "database" : envKey ? "environment" : "none",
  };
}

export async function listAIProviderModels(
  d: Db,
  input: { base_url?: string; api_key?: string; kind?: string },
): Promise<CatalogResult> {
  const record = await readRecord(d);
  const kind: MainModelKind = inferInputKind(input, record);
  const baseUrl = normalizeBase(kind, input.base_url?.trim() || (typeof record.base_url === "string" ? record.base_url : ""));
  if (!baseUrl) throw new RpcError("AI_PROVIDER_BASE_URL_INVALID", 400);
  if ((kind === "openai-compatible" || kind === "glm") && (!isCompatibleBaseUrl(baseUrl) || !isProviderEndpointAllowed(baseUrl))) {
    throw new RpcError("AI_PROVIDER_BASE_URL_INVALID", 400);
  }

  const suppliedKey = input.api_key?.trim() ?? "";
  const savedKey = storedKind(record) === kind && typeof record.api_key === "string" ? record.api_key : "";
  const apiKey = suppliedKey || savedKey || environmentKeyFor(kind);
  if (!keyConfigured(apiKey)) throw new RpcError("AI_PROVIDER_API_KEY_REQUIRED", 400);

  try {
    const client = createClientFor(kind, apiKey, baseUrl, KIND_LABEL[kind]);
    return await listProviderModels(client, {
      baseUrl,
      apiKey,
      provider: providerNameFor(kind),
      refresh: true,
    });
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError("AI_PROVIDER_CATALOG_FAILED", 502);
  }
}

export async function saveAIProviderConfig(
  d: Db,
  updaterUid: string,
  input: {
    kind?: string;
    base_url?: string;
    model: string;
    agent_model?: string;
    vision_model?: string;
    low_task_model?: string;
    api_key?: string;
    enabled?: boolean;
    label?: string;
    /** Skip the live catalog check (operator explicitly accepts an unlisted ID). */
    allow_unverified?: boolean;
  },
): Promise<PublicAIProviderConfig> {
  const current = await readRecord(d);
  const kind: MainModelKind = inferInputKind(input, current);
  const normalizedBase = normalizeBase(kind, input.base_url?.trim() || (typeof current.base_url === "string" ? current.base_url : ""));
  if (!normalizedBase) throw new RpcError("AI_PROVIDER_BASE_URL_INVALID", 400);
  if ((kind === "openai-compatible" || kind === "glm") && (!isCompatibleBaseUrl(normalizedBase) || !isProviderEndpointAllowed(normalizedBase))) {
    throw new RpcError("AI_PROVIDER_BASE_URL_INVALID", 400);
  }

  const normalizeModelId = (raw: string) => (kind === "gemini" ? raw.trim().replace(/^models\//, "") : raw.trim());
  const model = normalizeModelId(input.model);
  if (!model || model.length > 220) throw new RpcError("AI_PROVIDER_MODEL_INVALID", 400);
  const agentModel = normalizeModelId(input.agent_model ?? "");
  const visionModel = normalizeModelId(input.vision_model ?? "");
  const lowTaskModel = (input.low_task_model ?? "").trim();
  for (const candidate of [agentModel, visionModel, lowTaskModel]) {
    if (candidate.length > 220) throw new RpcError("AI_PROVIDER_MODEL_INVALID", 400);
  }
  const label = input.label?.trim().slice(0, 80) || KIND_LABEL[kind];

  const existingKey = storedKind(current) === kind && typeof current.api_key === "string" ? current.api_key : "";
  const newKey = input.api_key?.trim() ?? "";
  const apiKey = newKey || existingKey || environmentKeyFor(kind);
  if (!keyConfigured(apiKey)) throw new RpcError("AI_PROVIDER_API_KEY_REQUIRED", 400);
  if (!canEncryptSecrets()) throw new RpcError("SECRET_STORAGE_UNAVAILABLE", 503);

  if (input.allow_unverified !== true) {
    for (const id of new Set([model, ...(agentModel ? [agentModel] : []), ...(visionModel ? [visionModel] : [])])) {
      try {
        await verifyCatalogModelFor(kind, { baseUrl: normalizedBase, apiKey }, id);
      } catch (error) {
        const status = (error as { status?: number | null })?.status;
        throw new RpcError(status === 404 ? "AI_PROVIDER_MODEL_INVALID" : "AI_PROVIDER_CATALOG_FAILED", status === 404 ? 400 : 502);
      }
    }
  }

  await d.collection(COLLECTION).doc(DOC_ID).set(
    {
      kind,
      enabled: input.enabled !== false,
      base_url: normalizedBase,
      model,
      agent_model: agentModel,
      vision_model: visionModel,
      ...(lowTaskModel ? { low_task_model: lowTaskModel } : {}),
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

async function verifyCatalogModelFor(kind: MainModelKind, input: { baseUrl: string; apiKey: string }, model: string): Promise<void> {
  const client = createClientFor(kind, input.apiKey, input.baseUrl, KIND_LABEL[kind]);
  await verifyProviderModel(
    client,
    { baseUrl: input.baseUrl, apiKey: input.apiKey, provider: providerNameFor(kind) },
    model,
    providerNameFor(kind),
  );
}

export async function testAIProviderConfig(
  d: Db,
  mode: "general" | "agent" | "vision" = "general",
): Promise<{ ok: boolean; provider: AIProviderName; model: string; base_url: string; mode: "general" | "agent" | "vision"; detail: string }> {
  const config = await resolveMainModelConfig(d);
  const route = mode === "agent"
    ? createRuntimeAgentRoute(config)
    : mode === "vision" ? createRuntimeVisionRoute(config) : createRuntimeAIRoute(config);
  if (!route) throw new RpcError("AI_PROVIDER_NOT_CONFIGURED", 400);
  const ok = await route.client.healthCheck(route.model);
  return {
    ok,
    provider: route.provider,
    model: route.model,
    base_url: config?.base_url ?? "",
    mode,
    detail: ok
      ? `${KIND_LABEL[route.kind]} answered a live ${mode === "agent" ? "Agent / coding" : mode === "vision" ? "vision" : "chat"} check with ${route.model}.`
      : `${KIND_LABEL[route.kind]} did not pass the live check for model "${route.model}". Confirm the API key, that the model ID exists in this account's catalog, and that billing/quota is enabled for it.`,
  };
}
