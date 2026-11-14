"use client";

// MATRIX runs on one model. This page shows what it is and whether it is
// reachable right now. There is nothing to select.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, RefreshCw, X } from "lucide-react";
import { Alert, Badge, Button, Card } from "@/components/ui";

type ModelInfo = {
  id: string; label: string; provider: string; configured: boolean;
  streaming: boolean; tool_calling: boolean; vision: boolean;
  health: "online" | "unavailable" | "not-configured"; error: string | null; checked_at: string;
};
type Payload = { model: ModelInfo; used_for: string[] };

function Capability({ on, label }: { on: boolean; label: string }) {
  return <li className="flex items-center gap-2 text-sm">
    {on ? <Check size={15} className="shrink-0 text-success" aria-hidden /> : <X size={15} className="shrink-0 text-ink-3" aria-hidden />}
    <span className={on ? "text-ink" : "text-ink-3"}>{label}{on ? "" : " — not available"}</span>
  </li>;
}

export function ModelsClient({ showChatLink = true }: { showChatLink?: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/models", { cache: "no-store", credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load the model status.");
      setData(body);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load the model status."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const model = data?.model;
  const tone = model?.health === "online" ? "text-success" : model?.health === "unavailable" ? "text-danger" : "text-warning";
  const statusLabel = model?.health === "online" ? "Online" : model?.health === "unavailable" ? "Unavailable" : "Not configured";

  return <div className="mx-auto max-w-3xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="eyebrow text-accent">Intelligence</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Model</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">MATRIX runs entirely on one model. Chat, Agent, website generation, code and every other AI feature use it. There is no model to choose and no fallback to a different model.</p>
      </div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Check again</Button>
    </header>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {loading && !data ? <Card><p className="text-sm text-ink-2">Checking the model…</p></Card> : null}
    {model ? <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{model.label}</h2>
          <p className="mt-1 break-all font-mono text-xs text-ink-2">{model.id}</p>
          <p className="mt-1 text-xs text-ink-3">Served by {model.provider}</p>
        </div>
        <Badge className={tone}>{statusLabel}</Badge>
      </div>
      {model.health === "unavailable" ? <Alert tone="warning">The model did not answer the live check{model.error ? ` (${model.error})` : ""}. Requests will show a provider error until it recovers; your messages and projects are kept, and you can retry. MATRIX does not switch to another model.</Alert> : null}
      {model.health === "not-configured" ? <Alert tone="warning">No API key for the model is installed on the server (GROQ_API_KEY). AI features are unavailable until it is added.</Alert> : null}
      <ul className="grid gap-2 sm:grid-cols-3">
        <Capability on={model.streaming} label="Streaming" />
        <Capability on={model.tool_calling} label="Tool calling" />
        <Capability on={model.vision} label="Image understanding" />
      </ul>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Used for</p>
        <p className="mt-1.5 text-sm text-ink-2">{data?.used_for.join(" · ")}</p>
      </div>
      {showChatLink ? <Link href="/chat" className="btn-primary inline-flex">Open chat</Link> : null}
    </Card> : null}
  </div>;
}
