"use client";

// Model settings: every registered model with its real configuration and
// current availability, and the switches for the user's active pool.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, RefreshCw, Sparkles, X } from "lucide-react";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { cn } from "@/lib/utils";
import { onModelPoolChange, saveModelPool } from "@/components/model-picker";
import { STRENGTH_LABEL, type ModelStatus, type PoolPreference } from "@/lib/ai/models/types";

type DefaultModel = { health: "online" | "unavailable" | "not-configured" | "unchecked"; error: string | null; checked_at: string };
type Payload = { model: DefaultModel; models: ModelStatus[]; pool: PoolPreference; max_active: number };

function Capability({ on, label }: { on: boolean; label: string }) {
  return <li className="flex items-center gap-1.5 text-xs">
    {on ? <Check size={13} className="shrink-0 text-success" aria-hidden /> : <X size={13} className="shrink-0 text-ink-3" aria-hidden />}
    <span className={on ? "text-ink-2" : "text-ink-3"}>{label}{on ? "" : " — no"}</span>
  </li>;
}

const SAVE_ERRORS: Record<string, string> = {
  MODEL_UNAVAILABLE: "That model isn't available right now, so it can't be switched on.",
  EMPTY_MODEL_POOL: "Keep at least one model on, or use Auto.",
};

export function ModelsClient({ showChatLink = true }: { showChatLink?: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/models?check=1", { cache: "no-store", credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error("load");
      setData(body);
    } catch { setError("Model status couldn't be loaded. Check your connection and try again."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onModelPoolChange((pool) => setData((current) => (current ? { ...current, pool } : current))), []);

  const pool = data?.pool ?? { auto: true, enabled: [] };
  const available = data?.models.filter((model) => model.availability === "available") ?? [];
  const activeCount = pool.auto ? Math.min(available.length, data?.max_active ?? 4) : pool.enabled.filter((key) => available.some((model) => model.key === key)).length;

  async function apply(next: PoolPreference, key: string) {
    if (!data) return;
    const previous = data.pool;
    setData({ ...data, pool: next });
    setSaving(key); setError("");
    try {
      const saved = await saveModelPool(next);
      setData((current) => (current ? { ...current, pool: saved } : current));
    } catch (err) {
      setData((current) => (current ? { ...current, pool: previous } : current));
      setError(SAVE_ERRORS[err instanceof Error ? err.message : ""] ?? "The change couldn't be saved. Try again.");
    } finally { setSaving(""); }
  }
  function toggle(key: string) {
    if (!data) return;
    const base = pool.auto ? [] : pool.enabled;
    const next = base.includes(key) ? base.filter((item) => item !== key) : [...base, key];
    if (next.length > data.max_active) { setError(`Up to ${data.max_active} models can work together on one request.`); return; }
    void apply(next.length ? { auto: false, enabled: next } : { auto: true, enabled: [] }, key);
  }

  const health = data?.model.health;
  return <div className="mx-auto max-w-3xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="eyebrow text-accent">Intelligence</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Models</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">Choose which models work on your requests in Chat and Agent. When more than one is on, each takes a different part of the job and you get one combined answer.</p>
      </div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Check again</Button>
    </header>
    <div aria-live="polite" className="space-y-2 empty:hidden">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {health === "unavailable" ? <Alert tone="warning">The default model did not answer the live check{data?.model.error ? ` (${data.model.error})` : ""}. Requests will show a provider error until it recovers.</Alert> : null}
      {health === "not-configured" ? <Alert tone="warning">No API key is installed on the server (GROQ_API_KEY). AI features are unavailable until it is added.</Alert> : null}
    </div>

    {loading && !data ? <div className="space-y-3" aria-busy="true">{[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl bg-surface-2/60" />)}</div> : null}

    {data ? <>
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles size={18} className={cn("mt-0.5 shrink-0", pool.auto ? "text-accent" : "text-ink-3")} />
          <div className="min-w-0">
            <h2 className="font-semibold">Auto</h2>
            <p className="text-sm text-ink-2">MATRIX uses every available model and decides who does what. {activeCount} active now.</p>
          </div>
        </div>
        <Button variant={pool.auto ? "secondary" : "primary"} disabled={pool.auto || saving === "auto"} onClick={() => void apply({ auto: true, enabled: [] }, "auto")}>{pool.auto ? "On" : "Use Auto"}</Button>
      </Card>

      <ul className="space-y-3">
        {data.models.map((model) => {
          const usable = model.availability === "available";
          const on = usable && (pool.auto || pool.enabled.includes(model.key));
          return <li key={model.key}>
            <Card className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">{model.label}{model.is_default ? <Badge>Default</Badge> : null}</h2>
                  <p className="mt-0.5 text-sm text-ink-2">{model.summary}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={usable ? "!border-success/40 !text-success" : "!border-warning/40 !text-warning"}>{usable ? "Available" : "Not available"}</Badge>
                  <button
                    type="button" role="switch" aria-checked={on} aria-label={`Use ${model.label}`} disabled={!usable || saving === model.key}
                    onClick={() => toggle(model.key)}
                    className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50", on ? "bg-accent" : "bg-surface-2 ring-1 ring-inset ring-border")}
                  >
                    <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]", on ? "left-[22px]" : "left-0.5")} />
                  </button>
                </div>
              </div>
              {!usable || model.reason !== "Ready" ? <p className="text-sm text-warning">{model.reason}</p> : null}
              <div className="flex flex-wrap gap-1.5">{model.strengths.map((strength) => <Badge key={strength}>{STRENGTH_LABEL[strength]}</Badge>)}</div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                <Capability on={model.streaming} label="Streaming" />
                <Capability on={model.tool_calling} label="Tool calling" />
                <Capability on={model.structured_output} label="Structured output" />
                <Capability on={false} label="Image understanding" />
              </ul>
              <dl className="grid gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-ink-3 sm:grid-cols-2">
                <div><dt className="inline">Provider: </dt><dd className="inline text-ink-2">{model.provider}</dd></div>
                <div className="min-w-0"><dt className="inline">Model ID: </dt><dd className="inline break-all font-mono text-ink-2">{model.model_id}</dd></div>
                <div><dt className="inline">Context window: </dt><dd className="inline text-ink-2">{model.context_tokens.toLocaleString()} tokens</dd></div>
                <div><dt className="inline">Longest reply: </dt><dd className="inline text-ink-2">{model.max_output_tokens.toLocaleString()} tokens</dd></div>
              </dl>
            </Card>
          </li>;
        })}
      </ul>
      <p className="text-xs text-ink-3">Availability is read from the provider&apos;s live model list for this server&apos;s account. A model that isn&apos;t listed there is never used.</p>
      {showChatLink ? <Link href="/chat" className="btn-primary inline-flex">Open chat</Link> : null}
    </> : null}
  </div>;
}
