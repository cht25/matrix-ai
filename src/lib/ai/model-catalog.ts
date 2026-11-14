import { AIProviderError, providerErrorFromException, providerErrorFromResponse, type AIProviderName } from "@/lib/ai/provider-error";

export type CatalogModel = { id: string; label: string; ownedBy?: string; contextTokens?: number };
export type CatalogResult = { models: CatalogModel[]; verifiedAt: string };
const cache = new Map<string, { expires: number; result: CatalogResult }>();
const pending = new Map<string, Promise<CatalogResult>>();
export const CATALOG_TTL_MS = 5 * 60_000;

/** Accept the actual OpenAI/Ollama and Anthropic catalog shapes, never invented IDs. */
export function parseModelCatalog(payload: unknown): CatalogModel[] {
  const root = payload as { data?: unknown; models?: unknown } | null;
  const rows = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const raw = item.id ?? item.name;
    if (typeof raw !== "string") continue;
    const id = raw.replace(/^models\//, "").trim();
    if (!id || id.length > 220 || /[\x00-\x1f\s]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const context = Number(item.context_window ?? item.context_length ?? item.input_token_limit);
    models.push({ id, label: typeof item.display_name === "string" ? item.display_name.slice(0, 160) : id,
      ...(typeof item.owned_by === "string" ? { ownedBy: item.owned_by.slice(0, 100) } : {}),
      ...(Number.isInteger(context) && context >= 1024 && context <= 10_000_000 ? { contextTokens: context } : {}),
    });
    if (models.length >= 2000) break;
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Catalog fetched using the configured account's credentials; bounded and non-redirecting. */
export async function fetchModelCatalog(input: {
  baseUrl: string; apiKey?: string; provider?: AIProviderName; headers?: Record<string, string>; refresh?: boolean;
}): Promise<CatalogResult> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/models`);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid provider catalog URL");
  const headers = { ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}), ...input.headers };
  // Cache keyed by endpoint + credential fingerprint; no secret is serialized.
  const key = `${url.href}|${Object.entries(headers).sort().map(([k, v]) => `${k}:${v.slice(-8)}`).join("|")}`;
  const hit = cache.get(key);
  if (!input.refresh && hit && hit.expires > Date.now()) return hit.result;
  const inflight = pending.get(key);
  if (!input.refresh && inflight) return inflight;
  const task = (async () => {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const text = await response.text();
    if (!response.ok) throw providerErrorFromResponse(input.provider ?? "OpenAI", "catalog", response, text.slice(0, 2000));
    if (text.length > 2_000_000) throw new Error("Provider catalog exceeds the 2 MB safety limit");
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error("Provider returned an invalid model catalog"); }
    const models = parseModelCatalog(payload);
    if (!models.length) throw new Error("Provider returned no usable model IDs");
    const result = { models, verifiedAt: new Date().toISOString() };
    cache.set(key, { expires: Date.now() + CATALOG_TTL_MS, result });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return result;
  })().catch((error) => {
    if (error instanceof AIProviderError) throw error;
    throw providerErrorFromException(input.provider ?? "OpenAI", "catalog", error);
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export async function verifyCatalogModel(input: Parameters<typeof fetchModelCatalog>[0], model: string): Promise<void> {
  const catalog = await fetchModelCatalog(input);
  if (!catalog.models.some((item) => item.id === model)) {
    throw new AIProviderError({ provider: input.provider ?? "OpenAI", model, status: 404, type: "invalid_request", detail: `Model ${model} is not present in this provider's account catalog. Choose a listed model; MATRIX will not guess a replacement.` });
  }
}

export function resetModelCatalogCache(): void { cache.clear(); pending.clear(); }

/**
 * List a provider's real catalog through its own adapter when it has one.
 *
 * `AIProvider.listModels` is the single source of truth: Gemini parses
 * Google's `/v1beta/models` shape, Anthropic sends `x-api-key`, and an
 * OpenAI-compatible endpoint uses the bearer catalog. Falling back to the raw
 * OpenAI shape is only for adapters without native catalog support.
 */
export async function listProviderModels(
  client: { listModels?: () => Promise<CatalogModel[]> },
  fallback: Parameters<typeof fetchModelCatalog>[0],
): Promise<CatalogResult> {
  if (typeof client.listModels === "function") {
    const models = await client.listModels();
    if (!models.length) throw new Error("Provider returned no usable model IDs");
    return { models, verifiedAt: new Date().toISOString() };
  }
  return fetchModelCatalog({ ...fallback, refresh: true });
}

/** Verify one model ID using the provider's own catalog (cached per adapter). */
export async function verifyProviderModel(
  client: { listModels?: () => Promise<CatalogModel[]> },
  fallback: Parameters<typeof fetchModelCatalog>[0],
  model: string,
  provider: AIProviderName,
): Promise<void> {
  const catalog = await listProviderModels(client, fallback);
  if (!catalog.models.some((item) => item.id === model)) {
    throw new AIProviderError({
      provider,
      model,
      status: 404,
      type: "invalid_request",
      detail: `Model ${model} is not present in this provider's account catalog. Choose a listed model; MATRIX will not guess a replacement.`,
    });
  }
}
