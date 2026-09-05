"use client";

// Admin → AI configuration → Image generation.
//
// The API key travels in ONE direction only: browser → MATRIX backend. It is
// never read back, never rendered, never stored in localStorage. Once saved,
// the field is replaced by a masked "Configured" state with a Replace action.

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, XCircle } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { errorCodeOf } from "@/lib/admin-errors";
import { Alert, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";

type PublicConfig = {
  configured: boolean;
  enabled: boolean;
  provider: string;
  provider_label: string;
  model: string;
  api_key_set: boolean;
  api_key_last4: string;
  source: "database" | "environment" | "none";
  updated_at: string;
  available_models: Array<{ id: string; label: string }>;
};

type TestResult = { ok: boolean; code: string; provider: string; model: string; latency_ms: number };

const SAVE_ERRORS: Record<string, string> = {
  PERMISSION_DENIED: "Your role does not include the system.settings permission, which is required to manage AI providers.",
  IMAGE_PROVIDER_API_KEY_REQUIRED: "An API key is required the first time you configure this provider.",
  IMAGE_PROVIDER_MODEL_INVALID: "Choose a valid image model.",
  SECRET_STORAGE_UNAVAILABLE:
    "Secret storage is not available on this deployment. Set PROVIDER_SECRET_KEY (or GITHUB_TOKEN_ENCRYPTION_KEY) so the key can be encrypted at rest.",
};

const TEST_MESSAGES: Record<string, string> = {
  OK: "connection successful",
  NOT_CONFIGURED: "not configured — save an API key first",
  AUTH_FAILED: "connection failed — the API key was rejected",
  RATE_LIMITED: "connection failed — the provider is rate limiting this key",
  MODEL_INVALID: "connected, but the selected model is not available on this account",
  UNREACHABLE: "connection failed — the provider could not be reached",
};

export function ImageProviderSettings() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("together");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const value = await rpc<PublicConfig>("admin_image_provider_get");
      setConfig(value);
      setProvider(value.provider);
      setModel(value.model);
      setEnabled(value.enabled);
      setApiKey("");
      setReplacingKey(!value.api_key_set);
    } catch (error) {
      const code = errorCodeOf(error, "LOAD_FAILED");
      setMessage({ tone: code === "PERMISSION_DENIED" ? "warning" : "danger", text: SAVE_ERRORS[code] ?? "Could not load image provider settings." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setMessage(null);
    setTest(null);
    try {
      const value = await rpc<PublicConfig>("admin_image_provider_save", { provider, model, api_key: apiKey, enabled });
      setConfig(value);
      setApiKey("");
      setReplacingKey(false);
      setMessage({ tone: "success", text: "Image provider configuration saved. Run Test connection to verify it live." });
    } catch (error) {
      const code = errorCodeOf(error, "SAVE_FAILED");
      setMessage({ tone: "danger", text: SAVE_ERRORS[code] ?? "Could not save the image provider configuration." });
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setMessage(null);
    try {
      setTest(await rpc<TestResult>("admin_image_provider_test"));
    } catch (error) {
      const code = errorCodeOf(error, "TEST_FAILED");
      setMessage({ tone: "danger", text: SAVE_ERRORS[code] ?? "The connection test could not be run." });
    } finally {
      setTesting(false);
    }
  }

  async function clearKey() {
    if (!confirm("Remove the stored API key? Image generation will stop until a new key is saved.")) return;
    try {
      const value = await rpc<PublicConfig>("admin_image_provider_clear_key");
      setConfig(value);
      setTest(null);
      setReplacingKey(true);
      setMessage({ tone: "success", text: "Stored API key removed." });
    } catch {
      setMessage({ tone: "danger", text: "Could not remove the stored API key." });
    }
  }

  if (loading) {
    return (
      <Card>
        <span className="inline-status"><Spinner /> Loading image provider…</span>
      </Card>
    );
  }

  const models = config?.available_models ?? [];

  return (
    <Card className="space-y-5">
      <div>
        <p className="eyebrow">AI providers</p>
        <h2 className="mt-1 text-lg font-semibold text-ink">Image generation</h2>
        <p className="mt-1 text-sm text-ink-2">
          MATRIX calls the image provider from the server. The API key is encrypted at rest and is
          never sent to the browser.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider" htmlFor="image-provider">
          <Select id="image-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="together">Together AI</option>
          </Select>
        </Field>

        <Field label="Model" htmlFor="image-model">
          <Select id="image-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 ? <option value="">Select image model</option> : null}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
        </Field>
      </div>

      {/* --- API key --------------------------------------------------------- */}
      {config?.api_key_set && !replacingKey ? (
        <div className="panel flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink">API key</p>
            <p className="mono text-sm text-ink-2">
              ••••••••••••{config.api_key_last4}
            </p>
            <p className="mt-1 text-xs text-success">
              ✓ Configured{config.source === "environment" ? " from the server environment" : ""}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setReplacingKey(true)}>
              <KeyRound size={15} strokeWidth={1.8} aria-hidden="true" /> Replace key
            </Button>
            {config.source === "database" ? (
              <Button variant="ghost" onClick={() => void clearKey()}>Remove</Button>
            ) : null}
          </div>
        </div>
      ) : (
        <Field
          label="API key"
          htmlFor="image-api-key"
          hint="Stored encrypted on the server. It is never shown again after saving."
        >
          <Input
            id="image-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste the provider API key"
          />
        </Field>
      )}

      <label className="flex items-center gap-2.5 text-sm text-ink-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-accent" />
        Enable image generation
      </label>

      {/* --- status ---------------------------------------------------------- */}
      <div className="panel flex flex-wrap items-center gap-2 p-3 text-sm">
        <span className="font-medium text-ink">Status</span>
        {!config?.configured ? (
          <span className="chip"><span className="status-dot" aria-hidden="true" /> Not configured</span>
        ) : test ? (
          <span className={test.ok ? "chip border-success/40 bg-success-soft text-success" : "chip border-danger/40 bg-danger-soft text-danger"}>
            <span className="status-dot" data-state={test.ok ? "ok" : "down"} aria-hidden="true" />
            {test.ok ? `${test.provider} connected` : "Connection failed"}
          </span>
        ) : (
          // Configured, but not yet verified — we do NOT claim "Connected".
          <span className="chip"><span className="status-dot" data-state="warn" aria-hidden="true" /> Configured — not verified</span>
        )}
      </div>

      {test ? (
        <Alert tone={test.ok ? "success" : "danger"}>
          <span className="flex items-start gap-2">
            {test.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
            <span>
              {test.provider || "Image provider"} {TEST_MESSAGES[test.code] ?? "connection failed"}
              {test.ok ? <span className="mono text-xs text-ink-3"> · {test.model} · {test.latency_ms}ms</span> : null}
              {!test.ok && test.code !== "NOT_CONFIGURED" ? <span className="block text-xs">Check the image provider configuration.</span> : null}
            </span>
          </span>
        </Alert>
      ) : null}

      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={saving} aria-busy={saving}>
          {saving ? "Saving…" : "Save configuration"}
        </Button>
        <Button variant="secondary" onClick={() => void runTest()} disabled={testing || !config?.configured} aria-busy={testing}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
      </div>
    </Card>
  );
}
