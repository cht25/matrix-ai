"use client";

// Admin → AI configuration → Main model.
//
// One card that owns the single most important setting in MATRIX: which model
// answers chat, Agent/coding and vision requests. It supports three provider
// protocols (Google Gemini REST, OpenAI-compatible, Anthropic Messages),
// fetches the real account catalog, lets the operator pick model IDs, and
// stores the key encrypted — the raw key never returns to this page.
//
// Everything is editable: kind, endpoint, chat model, Agent model, vision
// model and enable/disable. Live tests prove each lane actually answers.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { errorCodeOf } from "@/lib/admin-errors";
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

type Kind = "glm" | "openai-compatible" | "anthropic" | "gemini";

type PublicConfig = {
  configured: boolean;
  enabled: boolean;
  kind: Kind;
  kind_label: string;
  base_url: string;
  model: string;
  agent_model: string;
  vision_model: string;
  low_task_model?: string;
  api_key_set: boolean;
  api_key_last4: string;
  updated_by: string;
  updated_at: string;
  label: string;
  suggested_models: string[];
  environment_key: boolean;
  source: "database" | "environment" | "none";
};

type CatalogModel = { id: string; label: string };
type Message = { tone: "info" | "success" | "warning" | "danger"; text: string } | null;

const KINDS: Array<{ id: Kind; label: string; hint: string }> = [
  { id: "glm", label: "GLM (Zhipu AI / Z.ai)", hint: "Primary engine for coding, web dev, Agent, vision & high-load tasks." },
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "gpt-oss-120b, Groq, OpenAI, Together, vLLM, Ollama…" },
  { id: "anthropic", label: "Anthropic Claude API", hint: "Native Messages API." },
  { id: "gemini", label: "Google Gemini (optional)", hint: "Optional secondary generateContent REST adapter." },
];

const NATIVE_ENDPOINT: Record<Exclude<Kind, "openai-compatible">, string> = {
  glm: "https://open.bigmodel.cn/api/paas/v4",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

const ERROR_MAP: Record<string, string> = {
  PERMISSION_DENIED: "Your role does not include the system.settings permission, which is required to manage the main model.",
  AI_PROVIDER_BASE_URL_INVALID: "Enter a valid public HTTPS base URL without credentials (for example https://api.openai.com/v1).",
  AI_PROVIDER_MODEL_INVALID: "That model ID is not in this account's catalog. Load the catalog and pick a listed ID.",
  AI_PROVIDER_API_KEY_REQUIRED: "An API key is required the first time. Leave the field blank only to keep the saved key.",
  AI_PROVIDER_NOT_CONFIGURED: "Save the model settings before running a live test.",
  AI_PROVIDER_CATALOG_FAILED: "The provider catalog could not be verified. Check the key, endpoint and provider status, then retry.",
  SECRET_STORAGE_UNAVAILABLE: "Server-side secret encryption is not configured (set PROVIDER_SECRET_KEY). Nothing was saved.",
  BAD_REQUEST: "Some of the values are not valid. Check the endpoint and model IDs.",
};

function errorText(error: unknown, fallback: string): string {
  const code = errorCodeOf(error, "REQUEST_FAILED");
  return ERROR_MAP[code] ?? fallback;
}

export function AiProviderSettings() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<Kind>("glm");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [lowTaskModel, setLowTaskModel] = useState("openai/gpt-oss-120b");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [useEnvKey, setUseEnvKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"general" | "agent" | "vision" | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [lastTest, setLastTest] = useState<Record<string, { ok: boolean; text: string }>>({});

  const applyConfig = useCallback((value: PublicConfig) => {
    setConfig(value);
    setKind(value.kind);
    setBaseUrl(value.base_url || (value.kind === "openai-compatible" ? "" : NATIVE_ENDPOINT[value.kind]));
    setModel(value.model);
    setAgentModel(value.agent_model ?? "");
    setVisionModel(value.vision_model ?? "");
    setLowTaskModel(value.low_task_model || "openai/gpt-oss-120b");
    setEnabled(value.enabled);
    setApiKey("");
    setUseEnvKey(value.environment_key);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      applyConfig(await rpc<PublicConfig>("admin_ai_provider_get"));
    } catch (error) {
      setMessage({ tone: errorCodeOf(error, "") === "PERMISSION_DENIED" ? "warning" : "danger", text: errorText(error, "Could not load the main model settings.") });
    } finally {
      setLoading(false);
    }
  }, [applyConfig]);

  useEffect(() => { void load(); }, [load]);

  const suggested = useMemo(() => {
    const rows = [...(config?.kind === kind ? config.suggested_models : [])];
    if (kind === "glm" && !rows.length) rows.push("glm-4.7", "glm-4.6", "glm-4.6v", "glm-4.5", "glm-4.5-air");
    return Array.from(new Set([...rows, ...catalog.map((item) => item.id)])).slice(0, 400);
  }, [catalog, config?.kind, config?.suggested_models, kind]);

  async function loadModels() {
    setCatalogLoading(true);
    setMessage(null);
    try {
      const result = await rpc<{ models: CatalogModel[]; verifiedAt: string }>("admin_ai_provider_models", {
        kind,
        base_url: baseUrl,
        api_key: apiKey,
      });
      setCatalog(result.models);
      setMessage({ tone: "success", text: `Loaded ${result.models.length} real model IDs from this provider account.` });
    } catch (error) {
      setCatalog([]);
      setMessage({ tone: "danger", text: errorText(error, "The provider did not return a model catalog.") });
    } finally {
      setCatalogLoading(false);
    }
  }

  async function save(allowUnverified = false) {
    if (!model.trim()) {
      setMessage({ tone: "warning", text: "Choose the chat model ID first." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const value = await rpc<PublicConfig>("admin_ai_provider_save", {
        kind,
        base_url: baseUrl,
        model: model.trim(),
        agent_model: agentModel.trim(),
        vision_model: visionModel.trim(),
        low_task_model: lowTaskModel.trim(),
        api_key: apiKey,
        enabled,
        label: KINDS.find((entry) => entry.id === kind)?.label ?? "",
        allow_unverified: allowUnverified,
      });
      applyConfig(value);
      setLastTest({});
      setMessage({ tone: "success", text: "Main model saved. The next chat, Agent and vision request uses it." });
    } catch (error) {
      const code = errorCodeOf(error, "");
      setMessage({
        tone: code === "AI_PROVIDER_MODEL_INVALID" ? "warning" : "danger",
        text: `${errorText(error, "Could not save the main model.")}${code === "AI_PROVIDER_MODEL_INVALID" ? " You can still save an unlisted ID if the provider rejects catalog listing." : ""}`,
      });
    } finally {
      setSaving(false);
    }
  }

  async function test(mode: "general" | "agent" | "vision") {
    setTesting(mode);
    setMessage(null);
    try {
      const result = await rpc<{ ok: boolean; provider: string; model: string; detail: string }>("admin_ai_provider_test", { mode });
      setLastTest((current) => ({ ...current, [mode]: { ok: result.ok, text: result.ok ? `${result.provider} · ${result.model}` : result.detail } }));
      setMessage({ tone: result.ok ? "success" : "danger", text: result.ok ? `${mode === "agent" ? "Agent" : mode === "vision" ? "Vision" : "Chat"} lane answered live: ${result.provider} · ${result.model}` : result.detail });
    } catch (error) {
      setMessage({ tone: "danger", text: errorText(error, "Live connection test failed.") });
    } finally {
      setTesting(null);
    }
  }

  if (loading) {
    return <Card className="space-y-3"><div className="flex items-center gap-2 text-sm text-ink-3"><Spinner /> Loading the main model…</div></Card>;
  }

  const sourceLabel = config?.source === "database"
    ? config.enabled ? "Saved · active" : "Saved · disabled"
    : config?.source === "environment" ? "Environment key" : "Not configured";

  return (
    <div className="space-y-4">
      <Card className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">Main model · routing</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-ink">The one model that answers everything</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">
              MATRIX routes chat, Agent/coding and vision through this configuration first. Change the provider, endpoint
              or model and the next request uses it — no redeploy. Keys are encrypted server-side and never sent back to the browser.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={cn(config?.configured && config.enabled ? "!border-success/40 !text-success" : "!border-warning/40 !text-warning")}>{sourceLabel}</Badge>
            {config?.api_key_set ? <Badge>key ···{config.api_key_last4}</Badge> : null}
            {config?.environment_key ? <Badge>env key</Badge> : null}
          </div>
        </header>

        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Main model provider">
          {KINDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={kind === entry.id}
              onClick={() => {
                setKind(entry.id);
                setCatalog([]);
                if (entry.id !== "openai-compatible") setBaseUrl(NATIVE_ENDPOINT[entry.id]);
              }}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors",
                kind === entry.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
              )}
            >
              <span className="flex items-center justify-between gap-2 text-sm font-semibold text-ink">
                {entry.label}
                {kind === entry.id ? <CheckCircle2 size={16} className="text-accent" /> : null}
              </span>
              <span className="mt-1 block text-xs text-ink-3">{entry.hint}</span>
            </button>
          ))}
        </div>

        {kind === "openai-compatible" || kind === "glm" ? (
          <Field
            label={kind === "glm" ? "GLM Base URL" : "Base URL"}
            htmlFor="main-base-url"
            hint={kind === "glm"
              ? "Default: https://open.bigmodel.cn/api/paas/v4 (or https://api.z.ai/api/paas/v4 for Z.ai international)."
              : "Examples: https://api.groq.com/openai/v1 · https://api.openai.com/v1 · https://openrouter.ai/api/v1."}
          >
            <Input id="main-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={kind === "glm" ? "https://open.bigmodel.cn/api/paas/v4" : "https://api.openai.com/v1"} autoComplete="off" spellCheck={false} />
          </Field>
        ) : (
          <Field label="Native endpoint" htmlFor="main-native-url" hint="Fixed by the protocol adapter on purpose: native adapters are called through their own APIs.">
            <Input id="main-native-url" value={NATIVE_ENDPOINT[kind]} readOnly disabled />
          </Field>
        )}

        <div className="grid gap-4">
          <Field label="High-end / Primary model" htmlFor="main-model" hint="Used by GLM for high-load tasks, complex reasoning, web development, and coding.">
            <Input id="main-model" list="main-model-options" value={model} onChange={(event) => setModel(event.target.value)} placeholder={kind === "glm" ? "glm-4.7" : kind === "anthropic" ? "claude-sonnet-4-5" : "openai/gpt-oss-120b"} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Agent / coding / web-dev model (optional)" htmlFor="main-agent-model" hint="Dedicated coding & web development model (defaults to glm-4.7 when using GLM).">
            <Input id="main-agent-model" list="main-model-options" value={agentModel} onChange={(event) => setAgentModel(event.target.value)} placeholder="glm-4.7 (or same as primary model)" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Low-load fast task model" htmlFor="main-low-model" hint="Handles lightweight everyday tasks automatically (default: openai/gpt-oss-120b via GROQ_API_KEY / GPT_OSS_API_KEY).">
            <Input id="main-low-model" value={lowTaskModel} onChange={(event) => setLowTaskModel(event.target.value)} placeholder="openai/gpt-oss-120b" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Vision model (optional)" htmlFor="main-vision-model" hint="Used by the screenshot scanner and chat images (defaults to glm-4.6v when using GLM).">
            <Input id="main-vision-model" list="main-model-options" value={visionModel} onChange={(event) => setVisionModel(event.target.value)} placeholder="glm-4.6v" autoComplete="off" spellCheck={false} />
          </Field>
          <datalist id="main-model-options">
            {suggested.map((id) => <option key={id} value={id} />)}
          </datalist>
          {catalog.length ? (
            <Select
              aria-label="Pick a model from the verified provider catalog"
              value={[model, agentModel, visionModel].includes(catalog[0]?.id ?? "") ? catalog[0].id : ""}
              onChange={(event) => { if (event.target.value) setModel(event.target.value); }}
            >
              <option value="">Pick a verified catalog model…</option>
              {catalog.map((item) => <option key={item.id} value={item.id}>{item.label === item.id ? item.id : `${item.label} · ${item.id}`}</option>)}
            </Select>
          ) : null}
        </div>

        <Field
          label="API key"
          htmlFor="main-api-key"
          hint={config?.api_key_set
            ? `A key ending ${config.api_key_last4} is stored encrypted. Leave blank to keep it; enter a new value to rotate it.`
            : "Required the first time. Stored encrypted (AES-256-GCM) and never returned to this page."}
        >
          <Input id="main-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setUseEnvKey(false); }} placeholder={config?.api_key_set ? "•••••••• (blank keeps the saved key)" : "Provider API key"} />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/60 p-3">
          <label className="inline-flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Main model active
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={useEnvKey} onChange={(event) => setUseEnvKey(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Use the server environment key when none is saved
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void save(false)} disabled={saving || catalogLoading}>
            {saving ? <Spinner /> : <ShieldCheck size={15} />} Save main model
          </Button>
          <Button type="button" variant="outline" onClick={() => void save(true)} disabled={saving || catalogLoading}>
            Save without catalog check
          </Button>
          <Button type="button" variant="outline" onClick={() => void loadModels()} disabled={catalogLoading || saving}>
            {catalogLoading ? <Spinner /> : <RefreshCw size={15} />} Load account catalog
          </Button>
        </div>

        <div className="grid gap-2 border-t border-border pt-4 sm:grid-cols-3">
          {(["general", "agent", "vision"] as const).map((mode) => {
            const state = lastTest[mode];
            return (
              <div key={mode} className="rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium capitalize text-ink">{mode === "general" ? "Chat" : mode}</span>
                  {state ? <Badge className={state.ok ? "!border-success/40 !text-success" : "!border-danger/40 !text-danger"}>{state.ok ? "Live" : "Failed"}</Badge> : <Badge>Not tested</Badge>}
                </div>
                <p className="mt-1 truncate text-xs text-ink-3">{state?.text ?? "No live check yet."}</p>
                <Button type="button" variant="ghost" className="mt-2 !min-h-8 !px-2" onClick={() => void test(mode)} disabled={Boolean(testing) || !config?.configured}>
                  {testing === mode ? <Spinner /> : <Zap size={14} />} Test {mode === "general" ? "chat" : mode}
                </Button>
              </div>
            );
          })}
        </div>

        <Alert>
          A catalog match proves the model ID exists for this account; it is not a billing guarantee. Every save validates the
          IDs you entered, so a retired model fails loudly instead of silently degrading the assistant.
        </Alert>
      </Card>

      <Card className="space-y-2">
        <h3 className="flex items-center gap-2 font-semibold text-ink"><Sparkles size={16} className="text-accent" /> What uses this model</h3>
        <ul className="space-y-1 text-sm text-ink-2">
          <li>· Chat and temporary chat — the <strong>chat model</strong>.</li>
          <li>· Agent mode, coding auto-routing and the build pipeline — the <strong>Agent model</strong> when set, otherwise the chat model.</li>
          <li>· Screenshot scanner and image understanding — the <strong>vision model</strong> when set, otherwise the chat model.</li>
          <li>· Extra provider accounts added under <em>Providers &amp; models</em> run after this one, and environment fallbacks last.</li>
        </ul>
        {config?.updated_at ? <p className="text-xs text-ink-3">Last saved {new Date(config.updated_at).toLocaleString()}{config.updated_by ? ` by ${config.updated_by}` : ""}.</p> : null}
      </Card>
    </div>
  );
}
