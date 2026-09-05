// =============================================================================
// Image provider configuration — server-side only.
//
// SECURITY CONTRACT
//   · The API key is stored encrypted (AES-256-GCM) in
//     `system_settings/image_provider` and is NEVER returned to the browser.
//   · The public projection exposes only: configured, provider, model, last4.
//   · The browser calls MATRIX; MATRIX calls Together AI. The key is never in
//     client JS, localStorage, a NEXT_PUBLIC_ variable or the HTML source.
//   · Audit entries record that the configuration changed — never the key.
//
// If nothing is saved, the TOGETHER_API_KEY environment variable is used as a
// fallback so existing deployments keep working after this upgrade.
// =============================================================================

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Db, nowTs } from "@/lib/firebase/admin";
import { RpcError } from "@/lib/server/errors";
import { isRealSecret, type ImageProviderCredentials, type ImageProviderId } from "@/lib/ai/image/provider";
import { getImageProvider } from "@/lib/ai/image/registry";
import { TOGETHER_DEFAULT_MODEL } from "@/lib/ai/image/together-provider";

const COLLECTION = "system_settings";
const DOC_ID = "image_provider";

/** Public, browser-safe view. Contains no secret material. */
export type PublicImageProviderConfig = {
  configured: boolean;
  enabled: boolean;
  provider: ImageProviderId;
  provider_label: string;
  model: string;
  api_key_set: boolean;
  /** Last four characters only — enough to recognise which key is installed. */
  api_key_last4: string;
  source: "database" | "environment" | "none";
  updated_by: string;
  updated_at: string;
  available_models: Array<{ id: string; label: string }>;
};

// --- encryption --------------------------------------------------------------
// Reuses the deployment's existing secret material so no new env var is
// mandatory: the GitHub token key when present, otherwise the Firebase service
// account private key (both are already server-only secrets).
function encryptionSecret(): string {
  return (
    process.env.PROVIDER_SECRET_KEY?.trim() ||
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY?.trim() ||
    process.env.FIREBASE_PRIVATE_KEY?.trim() ||
    ""
  );
}

export function canEncryptSecrets(): boolean {
  return encryptionSecret().length >= 16;
}

function key(): Buffer {
  return createHash("sha256").update(encryptionSecret()).digest();
}

export function encryptSecret(value: string): string {
  if (!canEncryptSecrets()) throw new RpcError("SECRET_STORAGE_UNAVAILABLE", 500);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value: string): string {
  const [version, ivRaw, tagRaw, dataRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !dataRaw) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// --- storage -----------------------------------------------------------------
function asIso(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const ts = value as { toDate?: () => Date };
  return typeof ts.toDate === "function" ? ts.toDate().toISOString() : "";
}

type StoredRecord = {
  enabled?: boolean;
  provider?: string;
  model?: string;
  api_key_encrypted?: string;
  api_key_last4?: string;
  updated_by?: string;
  updated_at?: unknown;
};

async function readRecord(d: Db): Promise<StoredRecord> {
  const snap = await d.collection(COLLECTION).doc(DOC_ID).get();
  return snap.exists ? ((snap.data() ?? {}) as StoredRecord) : {};
}

function normalizeProvider(value: unknown): ImageProviderId {
  return value === "together" ? "together" : "together";
}

/**
 * Resolve the credentials the server should use right now.
 * Returns null when image generation is not configured at all — callers must
 * then report "Not configured" rather than pretending the feature works.
 */
export async function resolveImageCredentials(
  d: Db,
): Promise<{ provider: ImageProviderId; credentials: ImageProviderCredentials; source: "database" | "environment" } | null> {
  const record = await readRecord(d).catch(() => ({}) as StoredRecord);
  if (record.enabled !== false && record.api_key_encrypted) {
    const apiKey = decryptSecret(record.api_key_encrypted);
    if (isRealSecret(apiKey)) {
      return {
        provider: normalizeProvider(record.provider),
        credentials: { apiKey, model: record.model?.trim() || TOGETHER_DEFAULT_MODEL },
        source: "database",
      };
    }
  }
  // Environment fallback keeps existing deployments running.
  const envKey = (process.env.TOGETHER_API_KEY ?? "").trim();
  if (isRealSecret(envKey)) {
    return {
      provider: "together",
      credentials: { apiKey: envKey, model: process.env.TOGETHER_IMAGE_MODEL?.trim() || TOGETHER_DEFAULT_MODEL },
      source: "environment",
    };
  }
  return null;
}

/** Is image generation usable at all? (configuration presence, not liveness) */
export async function isImageGenerationConfigured(d: Db): Promise<boolean> {
  return (await resolveImageCredentials(d)) !== null;
}

/** Admin-facing config view. Never includes the key. */
export async function getImageProviderConfigPublic(d: Db): Promise<PublicImageProviderConfig> {
  const record = await readRecord(d);
  const resolved = await resolveImageCredentials(d);
  const providerId = normalizeProvider(record.provider ?? resolved?.provider);
  const provider = getImageProvider(providerId);

  return {
    configured: resolved !== null,
    enabled: record.enabled !== false,
    provider: providerId,
    provider_label: provider.label,
    model: record.model?.trim() || resolved?.credentials.model || TOGETHER_DEFAULT_MODEL,
    api_key_set: resolved !== null,
    api_key_last4:
      record.api_key_last4 ??
      (resolved?.source === "environment" ? resolved.credentials.apiKey.slice(-4) : ""),
    source: resolved?.source ?? "none",
    updated_by: record.updated_by ?? "",
    updated_at: asIso(record.updated_at),
    available_models: [...provider.models],
  };
}

/**
 * Save the image provider configuration.
 * A blank `api_key` means "keep the existing key" — the admin never has to
 * re-enter a secret to change the model.
 */
export async function saveImageProviderConfig(
  d: Db,
  updaterUid: string,
  input: { provider?: string; model?: string; api_key?: string; enabled?: boolean },
): Promise<PublicImageProviderConfig> {
  const providerId = normalizeProvider(input.provider);
  const provider = getImageProvider(providerId);
  const model = (input.model ?? "").trim() || TOGETHER_DEFAULT_MODEL;
  if (model.length > 200) throw new RpcError("IMAGE_PROVIDER_MODEL_INVALID", 400);

  const record = await readRecord(d);
  const newKey = (input.api_key ?? "").trim();
  let encrypted = record.api_key_encrypted ?? "";
  let last4 = record.api_key_last4 ?? "";

  if (newKey) {
    const check = provider.validate({ apiKey: newKey, model });
    if (!check.ok) throw new RpcError(`IMAGE_PROVIDER_${check.code}`, 400);
    if (!canEncryptSecrets()) throw new RpcError("SECRET_STORAGE_UNAVAILABLE", 500);
    encrypted = encryptSecret(newKey);
    last4 = newKey.slice(-4);
  } else if (!encrypted) {
    throw new RpcError("IMAGE_PROVIDER_API_KEY_REQUIRED", 400);
  }

  await d.collection(COLLECTION).doc(DOC_ID).set(
    {
      enabled: input.enabled !== false,
      provider: providerId,
      model,
      api_key_encrypted: encrypted,
      api_key_last4: last4,
      updated_by: updaterUid,
      updated_at: nowTs(),
    },
    { merge: true },
  );

  return getImageProviderConfigPublic(d);
}

/** Remove the stored key entirely (falls back to the environment, if any). */
export async function clearImageProviderKey(d: Db, updaterUid: string): Promise<PublicImageProviderConfig> {
  await d.collection(COLLECTION).doc(DOC_ID).set(
    { api_key_encrypted: "", api_key_last4: "", updated_by: updaterUid, updated_at: nowTs() },
    { merge: true },
  );
  return getImageProviderConfigPublic(d);
}

/**
 * Run a REAL connection test. The result is never fabricated: "Connected" is
 * only ever returned after the provider answered a live request.
 */
export async function testImageProviderConfig(
  d: Db,
): Promise<{ ok: boolean; code: string; provider: string; model: string; latency_ms: number }> {
  const resolved = await resolveImageCredentials(d);
  if (!resolved) {
    return { ok: false, code: "NOT_CONFIGURED", provider: "", model: "", latency_ms: 0 };
  }
  const provider = getImageProvider(resolved.provider);
  const status = await provider.getStatus(resolved.credentials);
  return {
    ok: status.ok,
    code: status.code,
    provider: provider.label,
    model: resolved.credentials.model,
    latency_ms: status.latencyMs,
  };
}
