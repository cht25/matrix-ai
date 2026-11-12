"use client";

import { useEffect, useState } from "react";
import { rpc } from "@/lib/client/api";
import { errorCodeOf } from "@/lib/admin-errors";
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";
import type { CatalogModel } from "@/lib/ai/model-catalog";
import type { ManagedModelConfig, ManagedProviderKind, ManagedProviderPublic } from "@/lib/ai/managed-providers";

type Draft = {
  id?: string;
  name: string;
  kind: ManagedProviderKind;
  base_url: string;
  api_key: string;
  enabled: boolean;
  models: ManagedModelConfig[];
};
type Notice = { tone: "info" | "success" | "warning" | "danger"; text: string } | null;
type ModelFlags = Partial<Pick<ManagedModelConfig, "enabled" | "use_for_chat" | "use_for_agent" | "use_for_vision">>;

const NATIVE_ENDPOINTS: Record<Exclude<ManagedProviderKind, "openai-compatible">, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1",
};
const KIND_LABEL: Record<ManagedProviderKind, string> = {
  "openai-compatible": "OpenAI-compatible API",
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
};
const ERROR_COPY: Record<string, string> = {
  PERMISSION_DENIED: "Your role needs system.settings permission to manage AI providers.",
  AI_PROVIDER_API_KEY_REQUIRED: "Enter a provider API key first, or leave it blank only when editing a provider with a saved key.",
  AI_MANAGED_PROVIDER_ENDPOINT_INVALID: "Use a valid public HTTPS OpenAI-compatible endpoint. Local HTTP requires explicit server configuration.",
  AI_PROVIDER_CATALOG_FAILED: "Could not reach the provider model catalog. Check the API key, endpoint, and provider availability.",
  AI_MANAGED_MODEL_NOT_IN_CATALOG: "A selected model is no longer listed by the provider. Refresh the catalog and choose available model IDs.",
  AI_MANAGED_PROVIDER_CONFLICT: "This provider changed while you were editing it. Reload the provider and verify the model catalog again before saving.",
  SECRET_STORAGE_UNAVAILABLE: "Server-side secret encryption is not configured; no provider key was saved.",
};

const PROVIDER_PRESETS: Array<{ label: string; name: string; kind: ManagedProviderKind; base_url: string; sampleModel: string }> = [
  { label: "Google Gemini", name: "Google Gemini", kind: "gemini", base_url: NATIVE_ENDPOINTS.gemini, sampleModel: "gemini-2.5-flash" },
  { label: "Groq", name: "Groq Cloud", kind: "openai-compatible", base_url: "https://api.groq.com/openai/v1", sampleModel: "llama-3.3-70b-versatile" },
  { label: "OpenAI", name: "OpenAI", kind: "openai-compatible", base_url: "https://api.openai.com/v1", sampleModel: "gpt-4.1-mini" },
  { label: "Anthropic", name: "Anthropic Claude", kind: "anthropic", base_url: NATIVE_ENDPOINTS.anthropic, sampleModel: "claude-sonnet-4-5" },
  { label: "Together AI", name: "Together AI", kind: "openai-compatible", base_url: "https://api.together.xyz/v1", sampleModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { label: "OpenRouter", name: "OpenRouter (optional)", kind: "openai-compatible", base_url: "https://openrouter.ai/api/v1", sampleModel: "" },
];

function freshDraft(): Draft {
  return { name: "Google Gemini", kind: "gemini", base_url: NATIVE_ENDPOINTS.gemini, api_key: "", enabled: true, models: [] };
}
function copyProvider(provider: ManagedProviderPublic): Draft {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    base_url: provider.base_url,
    api_key: "",
    enabled: provider.enabled,
    models: provider.models.map((model) => ({ ...model })),
  };
}
function errorText(error: unknown, fallback: string): string {
  const code = errorCodeOf(error, "REQUEST_FAILED");
  return ERROR_COPY[code] ?? fallback;
}

export function ManagedAIProviders() {
  const [providers, setProviders] = useState<ManagedProviderPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [manualModel, setManualModel] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  async function loadProviders() {
    setLoading(true);
    try {
      setProviders(await rpc<ManagedProviderPublic[]>("admin_ai_managed_providers_get"));
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error, "Could not load the managed AI provider registry.") });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void loadProviders(); }, []);

  function startAdd() {
    setDraft(freshDraft());
    setCatalog([]);
    setSelectedIds([]);
    setManualModel("");
    setNotice(null);
  }
  function startEdit(provider: ManagedProviderPublic) {
    setDraft(copyProvider(provider));
    setCatalog([]);
    setSelectedIds([]);
    setManualModel("");
    setNotice(null);
  }
  function closeDraft() {
    setDraft(null);
    setCatalog([]);
    setSelectedIds([]);
    setManualModel("");
  }

  async function fetchModels() {
    if (!draft) return;
    setCatalogLoading(true);
    setNotice(null);
    try {
      const result = await rpc<{ models: CatalogModel[]; verifiedAt: string }>("admin_ai_managed_models", {
        ...(draft.id ? { provider_id: draft.id } : {}),
        kind: draft.kind,
        name: draft.name,
        base_url: draft.base_url,
        api_key: draft.api_key,
      });
      setCatalog(result.models);
      setSelectedIds([]);
      setNotice({ tone: "success", text: `Loaded ${result.models.length} real model IDs from ${draft.name || KIND_LABEL[draft.kind]}.` });
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error, ERROR_COPY.AI_PROVIDER_CATALOG_FAILED) });
    } finally {
      setCatalogLoading(false);
    }
  }

  function addManualModel() {
    if (!draft) return;
    const raw = manualModel.trim();
    const id = draft.kind === "gemini" ? raw.replace(/^models\//, "") : raw;
    if (!id) return;
    if (draft.models.some((model) => model.id === id)) {
      setNotice({ tone: "info", text: "That model ID is already in this provider configuration." });
      return;
    }
    const visionReady = draft.kind === "gemini" || draft.kind === "anthropic" || /vision|vl|4o|gemini|claude|pixtral/i.test(id);
    setDraft({
      ...draft,
      models: [...draft.models, { id, label: id, enabled: true, use_for_chat: true, use_for_agent: true, use_for_vision: visionReady }],
    });
    setManualModel("");
    setNotice({ tone: "info", text: `Added ${id}. Click save (or “Save without catalog check” if the endpoint hides /models).` });
  }

  function addSelectedModels() {
    if (!draft) return;
    const existing = new Set(draft.models.map((model) => model.id));
    const added = catalog.filter((model) => selectedIds.includes(model.id) && !existing.has(model.id));
    setDraft({
      ...draft,
      models: [
        ...draft.models,
        ...added.map((model) => ({ id: model.id, label: model.label || model.id, enabled: true, use_for_chat: true, use_for_agent: false, use_for_vision: false })),
      ],
    });
    setSelectedIds([]);
    if (!added.length) setNotice({ tone: "info", text: "Those model IDs are already in this provider configuration." });
  }

  async function saveProvider(allowUnverified = false) {
    if (!draft) return;
    const pendingRaw = manualModel.trim();
    const pendingId = draft.kind === "gemini" ? pendingRaw.replace(/^models\//, "") : pendingRaw;
    const effectiveModels =
      pendingId && !draft.models.some((model) => model.id === pendingId)
        ? [
            ...draft.models,
            {
              id: pendingId,
              label: pendingId,
              enabled: true,
              use_for_chat: true,
              use_for_agent: true,
              use_for_vision: draft.kind === "gemini" || draft.kind === "anthropic" || /vision|vl|4o|gemini|claude|pixtral/i.test(pendingId),
            },
          ]
        : draft.models;
    const effectiveName = draft.name.trim() || KIND_LABEL[draft.kind];
    if (!effectiveModels.length) {
      setNotice({ tone: "warning", text: "Fetch the provider catalog or enter at least one model ID before saving." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await rpc<ManagedProviderPublic>("admin_ai_managed_provider_save", {
        ...draft,
        name: effectiveName,
        models: effectiveModels,
        allow_unverified: allowUnverified,
      });
      setProviders((current) => current.some((provider) => provider.id === saved.id)
        ? current.map((provider) => provider.id === saved.id ? saved : provider)
        : [...current, saved]);
      setNotice({ tone: "success", text: `${saved.name} saved with ${saved.models.length} model(s).` });
      closeDraft();
    } catch (error) {
      const code = errorCodeOf(error, "");
      setNotice({
        tone: "danger",
        text: code === "AI_PROVIDER_CATALOG_FAILED" || code === "AI_MANAGED_MODEL_NOT_IN_CATALOG"
          ? `${errorText(error, "Provider settings could not be saved.")} If this endpoint does not publish a /models catalog, use "Save without catalog check".`
          : errorText(error, "Provider settings could not be saved."),
      });
    } finally {
      setSaving(false);
    }
  }

  async function toggleProvider(provider: ManagedProviderPublic) {
    setBusyId(provider.id);
    try {
      const updated = await rpc<ManagedProviderPublic[]>("admin_ai_managed_provider_toggle", { id: provider.id, enabled: !provider.enabled });
      setProviders(updated);
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error, "Provider status could not be changed.") });
    } finally {
      setBusyId("");
    }
  }

  async function updateModel(provider: ManagedProviderPublic, model: ManagedModelConfig, patch: ModelFlags) {
    const id = `${provider.id}:${model.id}`;
    setBusyId(id);
    try {
      const updated = await rpc<ManagedProviderPublic[]>("admin_ai_managed_model_update", {
        provider_id: provider.id,
        model_id: model.id,
        ...patch,
      });
      setProviders(updated);
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error, "Model activation settings could not be changed.") });
    } finally {
      setBusyId("");
    }
  }

  async function deleteProvider(provider: ManagedProviderPublic) {
    if (!window.confirm(`Remove ${provider.name} and its saved model configuration?`)) return;
    setBusyId(provider.id);
    try {
      const updated = await rpc<ManagedProviderPublic[]>("admin_ai_managed_provider_delete", { id: provider.id });
      setProviders(updated);
      setNotice({ tone: "success", text: `${provider.name} removed from admin-managed routing.` });
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error, "Provider could not be removed.") });
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Admin managed · server-side keys</p>
            <h2 className="mt-1 text-lg font-semibold text-ink">Providers & models</h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">
              Add multiple provider accounts and choose verified models for Chat, Agent, and vision separately.
              Provider and model switches take effect on the next request; existing environment fallbacks remain available.
            </p>
          </div>
          <Button type="button" onClick={startAdd} disabled={loading || Boolean(draft)}>Add provider</Button>
        </div>
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
        {loading ? <span className="inline-status"><Spinner /> Loading provider registry…</span> : null}
        {!loading && providers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-5 text-sm text-ink-3">
            No admin-managed providers yet. Environment-configured providers continue to work until you add one here.
          </div>
        ) : null}
        <div className="space-y-3">
          {providers.map((provider) => (
            <section key={provider.id} className="rounded-xl border border-border bg-surface-2/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-ink">{provider.name}</h3>
                    <Badge>{KIND_LABEL[provider.kind]}</Badge>
                    <Badge className={provider.enabled ? "!border-success/40 !text-success" : "!border-warning/40 !text-warning"}>
                      {provider.enabled ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-ink-3">{provider.base_url} · key ending {provider.api_key_last4 || "????"}</p>
                  <p className="mt-1 text-xs text-ink-3">{provider.models.filter((model) => model.enabled).length} active / {provider.models.length} listed models</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant={provider.enabled ? "outline" : "secondary"} disabled={Boolean(busyId) || Boolean(draft)} onClick={() => void toggleProvider(provider)}>
                    {busyId === provider.id ? <Spinner /> : provider.enabled ? "Deactivate provider" : "Activate provider"}
                  </Button>
                  <Button type="button" variant="ghost" disabled={Boolean(busyId) || Boolean(draft)} onClick={() => startEdit(provider)}>Edit</Button>
                  <Button type="button" variant="danger" disabled={Boolean(busyId) || Boolean(draft)} onClick={() => void deleteProvider(provider)}>Remove</Button>
                </div>
              </div>
              {provider.models.length ? (
                <div className="mt-4 grid gap-2">
                  {provider.models.map((model) => {
                    const key = `${provider.id}:${model.id}`;
                    const disabled = Boolean(busyId) || busyId === key;
                    const toggles: { field: keyof ManagedModelConfig; label: string }[] = [
                      { field: "enabled", label: "Active" },
                      { field: "use_for_chat", label: "Chat" },
                      { field: "use_for_agent", label: "Agent" },
                      { field: "use_for_vision", label: "Vision" },
                    ];
                    return (
                      <div key={model.id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-xs text-ink">{model.id}</span>
                          {model.label !== model.id ? <span className="truncate text-xs text-ink-3">{model.label}</span> : null}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                          {toggles.map(({ field, label }) => (
                            <label key={field} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                              <input
                                type="checkbox"
                                checked={model[field] === true}
                                disabled={disabled}
                                onChange={(event) => void updateModel(provider, model, { [field]: event.target.checked } as ModelFlags)}
                                className="h-4 w-4 accent-[var(--accent)]"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : <p className="mt-3 text-xs text-warning">No models have been added.</p>}
            </section>
          ))}
        </div>
      </Card>

      {draft ? (
        <Card className="space-y-4">
          <div className="space-y-2">
            <p className="eyebrow">{draft.id ? "Edit provider" : "New provider"}</p>
            <h3 className="mt-1 text-lg font-semibold text-ink">Provider account and model access</h3>
            {!draft.id ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setDraft({
                        ...draft,
                        name: preset.name,
                        kind: preset.kind,
                        base_url: preset.base_url,
                        models: preset.sampleModel
                          ? [{
                              id: preset.sampleModel,
                              label: preset.sampleModel,
                              enabled: true,
                              use_for_chat: true,
                              use_for_agent: true,
                              use_for_vision: preset.kind === "gemini" || preset.kind === "anthropic",
                            }]
                          : [],
                      });
                      setCatalog([]);
                    }}
                    className="rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-accent hover:text-ink"
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Admin label" htmlFor="managed-provider-name" hint="For example: Gemini Research, Team Groq, or Production Claude.">
              <Input id="managed-provider-name" maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Provider name" />
            </Field>
            <Field label="Provider API" htmlFor="managed-provider-kind">
              <Select id="managed-provider-kind" value={draft.kind} onChange={(event) => {
                const kind = event.target.value as ManagedProviderKind;
                setDraft({ ...draft, kind, base_url: kind === "openai-compatible" ? "" : NATIVE_ENDPOINTS[kind], api_key: "", models: [] });
                setCatalog([]);
              }}>
                <option value="gemini">Google Gemini API</option>
                <option value="openai-compatible">OpenAI-compatible endpoint</option>
                <option value="anthropic">Anthropic Claude API</option>
              </Select>
            </Field>
            {draft.kind === "openai-compatible" ? (
              <Field label="Base URL" htmlFor="managed-provider-url" hint="Use the provider's API base URL, such as https://api.openai.com/v1. Local HTTP requires server-side AI_ALLOW_LOCAL_HTTP=true.">
                <Input id="managed-provider-url" type="url" value={draft.base_url} onChange={(event) => setDraft({ ...draft, base_url: event.target.value })} placeholder="https://api.example.com/v1" />
              </Field>
            ) : (
              <Field label="Native API endpoint" htmlFor="managed-provider-native-url" hint="This protocol adapter uses the vendor's official API and model catalog.">
                <Input id="managed-provider-native-url" value={NATIVE_ENDPOINTS[draft.kind]} readOnly disabled />
              </Field>
            )}
            <Field label="API key" htmlFor="managed-provider-key" hint={draft.id ? "Leave blank to preserve the encrypted key. A new value rotates it; the raw key is never returned to this page." : "Required for the first save. It is encrypted server-side."}>
              <Input id="managed-provider-key" type="password" autoComplete="new-password" value={draft.api_key} onChange={(event) => setDraft({ ...draft, api_key: event.target.value })} placeholder={draft.id ? "•••••••• (blank keeps saved key)" : "Provider API key"} />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void fetchModels()} disabled={catalogLoading || saving}>
              {catalogLoading ? <Spinner /> : "Fetch account model catalog"}
            </Button>
            <span className="text-xs text-ink-3">The list comes from this provider's real authenticated catalog; MATRIX does not invent model IDs.</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Field label="Add a model ID manually" htmlFor="managed-manual-model" hint="Press Enter or click Add model. Works for any model ID; use “Save without catalog check” if the endpoint hides /models.">
              <Input
                id="managed-manual-model"
                value={manualModel}
                onChange={(event) => setManualModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addManualModel();
                  }
                }}
                placeholder={draft.kind === "gemini" ? "e.g. gemini-2.5-flash" : draft.kind === "anthropic" ? "e.g. claude-sonnet-4-5" : "e.g. gpt-4.1-mini"}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Button type="button" variant="secondary" disabled={!manualModel.trim()} onClick={addManualModel}>Add model</Button>
          </div>

          {catalog.length ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Field label="Choose one or more models to add">
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border bg-surface p-2">
                  {catalog.map((model) => {
                    const checked = selectedIds.includes(model.id);
                    return (
                      <label key={model.id} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-sm hover:bg-surface-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedIds((current) => checked ? current.filter((id) => id !== model.id) : [...current, model.id])}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                        />
                        <span className="min-w-0">
                          <span className="block break-all font-mono text-xs text-ink">{model.id}</span>
                          {model.label !== model.id ? <span className="block text-xs text-ink-3">{model.label}</span> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </Field>
              <Button type="button" variant="secondary" onClick={addSelectedModels} disabled={!selectedIds.length}>Add selected models ({selectedIds.length})</Button>
            </div>
          ) : null}

          {draft.models.length ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-ink-2">Models in this provider</p>
              {draft.models.map((model) => (
                <div key={model.id} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="truncate font-mono text-xs text-ink">{model.id}</span>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    {([
                      ["enabled", "Active"],
                      ["use_for_chat", "Chat"],
                      ["use_for_agent", "Agent"],
                      ["use_for_vision", "Vision"],
                    ] as const).map(([field, label]) => (
                      <label key={field} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                        <input type="checkbox" checked={model[field]} onChange={(event) => setDraft({ ...draft, models: draft.models.map((item) => item.id === model.id ? { ...item, [field]: event.target.checked } : item) })} className="h-4 w-4 accent-[var(--accent)]" />
                        {label}
                      </label>
                    ))}
                    <Button type="button" variant="ghost" className="!min-h-8 !px-2 text-danger" onClick={() => setDraft({ ...draft, models: draft.models.filter((item) => item.id !== model.id) })}>Remove model</Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <label className="inline-flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="h-4 w-4 accent-[var(--accent)]" />
            Provider active
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void saveProvider(false)} disabled={saving || catalogLoading}>
              {saving ? <Spinner /> : draft.id ? "Save provider changes" : "Add provider and models"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void saveProvider(true)} disabled={saving || catalogLoading || (!draft.models.length && !manualModel.trim())}>
              Save without catalog check
            </Button>
            <Button type="button" variant="outline" onClick={closeDraft} disabled={saving}>Cancel</Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
