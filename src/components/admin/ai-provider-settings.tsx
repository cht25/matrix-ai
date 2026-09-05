"use client";

import { useEffect, useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { Alert, Badge, Button, Card, Field, Input, Spinner } from "@/components/ui";

type PublicConfig = {
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

type Message = { tone: "info" | "success" | "warning" | "danger"; text: string } | null;

const ERROR_MAP: Record<string, string> = {
  PERMISSION_DENIED: "Your role does not include the system.settings permission, which is required to manage the AI provider.",
  AI_PROVIDER_BASE_URL_INVALID: "The endpoint must be a valid http(s) URL without credentials (for example https://api.openai.com/v1).",
  AI_PROVIDER_MODEL_INVALID: "Enter a model ID (for example gpt-4o-mini or gpt-4.1-mini).",
  AI_PROVIDER_API_KEY_REQUIRED: "An API key is required when no key is already saved. Leave the field blank only to keep the existing key.",
  AI_PROVIDER_NOT_CONFIGURED: "Save the provider settings before testing the connection.",
};

export function AiProviderSettings() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"general" | "agent" | null>(null);
  const [message, setMessage] = useState<Message>(null);

  async function load() {
    setLoading(true);
    setMessage(null);
    try {
      const value = await rpc<PublicConfig>("admin_ai_provider_get");
      setConfig(value);
      setBaseUrl(value.base_url);
      setModel(value.model);
      setAgentModel(value.agent_model ?? "");
      setApiKey("");
      setEnabled(value.enabled);
    } catch (error) {
      const code = errorCodeOf(error, "LOAD_FAILED");
      setMessage({
        tone: code === "PERMISSION_DENIED" ? "warning" : "danger",
        text: ERROR_MAP[code] ?? "Could not load AI provider settings.",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const value = await rpc<PublicConfig>("admin_ai_provider_save", {
        base_url: baseUrl,
        model,
        agent_model: agentModel,
        api_key: apiKey,
        enabled,
        label: "OpenAI-compatible",
      });
      setConfig(value);
      setApiKey("");
      setMessage({ tone: "success", text: "AI provider settings saved. New chat and Agent requests will use this endpoint and model." });
    } catch (error) {
      const code = errorCodeOf(error, "SAVE_FAILED");
      setMessage({ tone: "danger", text: ERROR_MAP[code] ?? "Could not save AI provider settings." });
    } finally {
      setSaving(false);
    }
  }

  async function test(mode: "general" | "agent") {
    if (!config?.configured) {
      setMessage({ tone: "warning", text: ERROR_MAP.AI_PROVIDER_NOT_CONFIGURED });
      return;
    }
    setTesting(mode);
    setMessage(null);
    try {
      const result = await rpc<{ ok: boolean; provider: string; model: string; base_url: string; detail: string }>("admin_ai_provider_test", { mode });
      setMessage({
        tone: result.ok ? "success" : "danger",
        text: result.ok
          ? `${mode === "agent" ? "Agent model" : "Chat model"} OK · ${result.provider} · ${result.model}`
          : result.detail,
      });
    } catch (error) {
      const code = errorCodeOf(error, "TEST_FAILED");
      setMessage({ tone: "danger", text: ERROR_MAP[code] ?? "Connection test failed." });
    } finally {
      setTesting(null);
    }
  }

  if (loading) {
    return (
      <Card className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-ink-3"><Spinner /> Loading AI provider settings…</div>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">AI provider</h1>
          <p className="mt-1 text-sm text-ink-2">
            Set the OpenAI-compatible endpoint, model and API key used by the assistant.
            The key stays on the server and is never sent to the browser.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {config?.configured ? (
            <Badge className={config.enabled ? "!border-success/40 !text-success" : "!border-warning/40 !text-warning"}>
              {config.enabled ? (config.api_key_set ? "Configured" : "Not configured") : "Disabled"}
            </Badge>
          ) : (
            <Badge className="!border-warning/40 !text-warning">Using environment fallback</Badge>
          )}
        </div>
      </div>

      <div className="grid gap-4">
        <Field label="OpenAI-compatible endpoint" htmlFor="ai-base-url" hint="Examples: https://api.openai.com/v1 or https://openrouter.ai/api/v1. A full .../chat/completions URL is accepted too.">
          <Input
            id="ai-base-url"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field label="Chat model" htmlFor="ai-model" hint="The model ID used for everyday chat, for example gpt-4o-mini, gpt-4.1-mini or qwen/qwen3-coder.">
          <Input
            id="ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field label="Agent / coding model (optional)" htmlFor="ai-agent-model" hint="Used only for Agent mode — building and fixing projects. Leave blank to use the chat model. Pick a larger, long-output coding model here, for example gpt-4.1, qwen/qwen3-coder, claude-sonnet-4 or deepseek/deepseek-chat.">
          <Input
            id="ai-agent-model"
            value={agentModel}
            onChange={(e) => setAgentModel(e.target.value)}
            placeholder="Same as chat model (leave blank)"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          label="API key"
          htmlFor="ai-api-key"
          hint={config?.api_key_set ? `An API key is already saved (ending in ${config.api_key_last4}). Leave blank to keep it.` : "Required on first save."}
        >
          <Input
            id="ai-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.api_key_set ? "•••••••••••• (blank keeps current key)" : "sk-…"}
            autoComplete="new-password"
          />
        </Field>

        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Use this provider for chat, Agent/coding and screenshot analysis
        </label>
      </div>

      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={saving || testing !== null}>
          {saving ? <Spinner /> : "Save provider settings"}
        </Button>
        <Button type="button" variant="outline" onClick={() => void test("general")} disabled={testing !== null || saving}>
          {testing === "general" ? <Spinner /> : "Test chat model"}
        </Button>
        <Button type="button" variant="outline" onClick={() => void test("agent")} disabled={testing !== null || saving}>
          {testing === "agent" ? <Spinner /> : "Test Agent model"}
        </Button>
        <Button type="button" variant="ghost" onClick={load}>Reload</Button>
      </div>

      <p className="text-xs leading-relaxed text-ink-3">
        Chat uses the <strong>chat model</strong>; Agent mode uses the <strong>Agent/coding model</strong> when one is set
        (it falls back to the chat model, then to the environment providers: OpenRouter/Nemotron for Agent, Groq for chat).
        Use the two test buttons to confirm each model ID is accepted by the endpoint. Admin changes apply to the next
        request — no restart is needed. The API key stays on the server and is never sent to the browser.
      </p>
    </Card>
  );
}
