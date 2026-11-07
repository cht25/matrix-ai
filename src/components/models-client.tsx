"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Cpu, RefreshCw, Search } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Input } from "@/components/ui";
import { rpc } from "@/lib/client/api";

type Provider = { id: string; name: string; defaultModel: string; codingModel: string; models: { id: string; label: string }[]; verification: string; error?: string };
type Catalog = { providers: Provider[]; preference: { provider_id: string; model_id: string } };

export function ModelsClient() {
  const [data, setData] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/models", { cache: "no-store", credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load provider catalogs.");
      setData(body);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load models."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function select(provider: string, model: string) {
    setSaving(`${provider}/${model}`); setError("");
    try {
      await rpc("model_preference_set", { provider_id: provider, model_id: model });
      setData((current) => current ? { ...current, preference: { provider_id: provider, model_id: model } } : current);
    } catch { setError("Model preference could not be saved. Your previous selection is unchanged."); }
    finally { setSaving(""); }
  }
  async function automatic() {
    setSaving("auto");
    try { await rpc("model_preference_set", { provider_id: "", model_id: "" }); setData((current) => current ? { ...current, preference: { provider_id: "", model_id: "" } } : current); }
    catch { setError("Could not reset model routing."); }
    finally { setSaving(""); }
  }

  return <div className="mx-auto max-w-5xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="eyebrow text-accent"> Intelligence / routing</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Models</h1><p className="mt-2 max-w-2xl text-sm text-ink-2">Choose the intelligence behind your next conversation. Only IDs returned by your configured providers are shown.</p></div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh catalogs</Button>
    </header>
    <Alert>Catalog verification is not a guarantee of billing entitlement or vision capability. The provider validates access again when you send a request. API keys never leave the server.</Alert>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-sm font-medium">Current preference</p><p className="mt-1 break-all font-mono text-xs text-ink-2">{data?.preference.model_id ? `${data.preference.provider_id} / ${data.preference.model_id}` : "Automatic routing"}</p></div>
      <div className="flex gap-2"><Button variant="secondary" disabled={Boolean(saving)} onClick={() => void automatic()}>Use automatic</Button><Link href="/chat" className="btn-primary">Open chat</Link></div>
    </Card>
    <div className="relative"><Search size={16} className="absolute left-3 top-3.5 text-ink-3" /><Input className="pl-10" aria-label="Search models" placeholder="Search provider or model ID…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {loading && !data ? <Card><p className="text-sm text-ink-2">Verifying provider catalogs…</p></Card> : data?.providers.length === 0 ? <EmptyState icon={<Cpu />} title="No providers configured" body="Configure an existing provider in Admin → AI configuration, or add server credentials using the environment inventory." /> : null}
    {data?.providers.map((provider) => {
      const models = provider.models.filter((model) => `${provider.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
      return <Card key={provider.id} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{provider.name}</h2><Badge className={provider.error ? "text-warning" : "text-success"}>{provider.error ? "Catalog unavailable" : `${provider.models.length} listed models`}</Badge></div>
        {provider.error ? <Alert tone="warning">The provider catalog could not be verified ({provider.error}). Check the server configuration; no substitute models have been invented.</Alert> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {models.slice(0, 100).map((model) => {
            const selected = data.preference.provider_id === provider.id && data.preference.model_id === model.id;
            const key = `${provider.id}/${model.id}`;
            return <button type="button" key={model.id} disabled={Boolean(saving)} onClick={() => void select(provider.id, model.id)} aria-pressed={selected} className={`flex min-h-16 items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors ${selected ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"}`}>
              <span className="min-w-0"><span className="block break-all font-mono text-xs">{model.id}</span><span className="mt-1 block text-[11px] text-ink-3">{model.id === provider.codingModel ? "Configured for Agent / coding" : model.id === provider.defaultModel ? "Configured default" : "Provider-listed model"}</span></span>
              {selected ? <Check size={16} className="shrink-0 text-accent" /> : saving === key ? <RefreshCw size={14} className="animate-spin" /> : null}
            </button>;
          })}
        </div>
        {models.length > 100 ? <p className="text-xs text-ink-3">Showing the first 100 matches. Search to narrow the catalog.</p> : null}
        {!models.length && !provider.error ? <p className="text-sm text-ink-3">No models match this search.</p> : null}
      </Card>;
    })}
  </div>;
}
