"use client";

// Multi-model comparison workspace: one prompt → several routing lanes, each
// answer attributed to its real provider/model. Results are ephemeral
// (not saved to a conversation); failures show honest error codes.

import { useState } from "react";
import { Alert, Badge, Button, Card, Field, Spinner, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { Markdown } from "@/components/markdown";
import { Columns3, Copy, RefreshCw } from "lucide-react";

type Lane = "fast" | "balanced" | "reasoning" | "coding";
const LANES: Array<{ id: Lane; label: string }> = [
  { id: "fast", label: "Fast" },
  { id: "balanced", label: "Balanced" },
  { id: "reasoning", label: "Reasoning" },
  { id: "coding", label: "Coding" },
];

type LaneResult = {
  lane: Lane;
  provider: string;
  model: string;
  ok: boolean;
  content?: string;
  error?: string;
  latency_ms?: number;
};

export function CompareClient() {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<Lane[]>(["fast", "balanced", "reasoning"]);
  const [results, setResults] = useState<LaneResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(lane: Lane) {
    setSelected((s) => (s.includes(lane) ? s.filter((x) => x !== lane) : [...s, lane].slice(0, 3)));
  }

  async function run(lanes: Lane[]) {
    if (!prompt.trim() || lanes.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ai/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ message: prompt, lanes }),
      });
      const body = (await res.json()) as { results?: LaneResult[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "HTTP_" + res.status);
      setResults(body.results ?? []);
    } catch (err) {
      toast(err instanceof Error ? err.message.replace(/_/g, " ").toLowerCase() : "Comparison failed.");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(lane: Lane) {
    setResults((r) => (r ? r.map((x) => (x.lane === lane ? { ...x, ok: false, content: undefined, error: "regenerating…" } : x)) : r));
    await run([lane]);
    // merge: replace only that lane
    const res = await fetch("/api/ai/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ message: prompt, lanes: [lane] }),
    });
    if (res.ok) {
      const body = (await res.json()) as { results: LaneResult[] };
      const fresh = body.results[0];
      if (fresh) setResults((r) => (r ? r.map((x) => (x.lane === lane ? fresh : x)) : [fresh]));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Compare Models</h1>
        <p className="mt-1 text-ink-2">
          Send one prompt to multiple MATRIX routing lanes and compare the answers side by side. Every response is attributed
          to the provider and model that actually produced it.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <Field label="Prompt" htmlFor="compare-prompt">
          <Textarea
            id="compare-prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask something you want to compare answers for…"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          {LANES.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => toggle(l.id)}
              aria-pressed={selected.includes(l.id)}
              className={`min-h-9 rounded-full border px-3 text-[13px] font-medium transition-colors ${
                selected.includes(l.id) ? "border-accent bg-accent-soft text-accent" : "border-border text-ink-2 hover:bg-surface-2"
              }`}
            >
              {l.label}
            </button>
          ))}
          <span className="text-xs text-ink-3">max 3 lanes</span>
          <Button className="ml-auto" onClick={() => void run(selected)} disabled={busy || !prompt.trim() || selected.length === 0}>
            {busy ? <Spinner className="mr-2 h-4 w-4" /> : <Columns3 size={15} className="mr-2" />} Compare
          </Button>
        </div>
      </Card>

      {results ? (
        <div className={`grid gap-4 ${results.length > 1 ? "lg:grid-cols-2 xl:grid-cols-3" : ""}`}>
          {results.map((r) => (
            <Card key={r.lane} className="flex min-w-0 flex-col space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge>{r.lane}</Badge>
                  <span className="truncate font-mono text-[11px] text-ink-3">
                    {r.provider} · {r.model}
                  </span>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Regenerate ${r.lane}`}
                    className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
                    onClick={() => void regenerate(r.lane)}
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Copy ${r.lane} response`}
                    className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
                    disabled={!r.ok || !r.content}
                    onClick={() => {
                      void navigator.clipboard.writeText(r.content ?? "");
                      toast("Copied.");
                    }}
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
              {r.ok && r.content ? (
                <>
                  <div className="min-w-0 flex-1 text-sm leading-relaxed text-ink">
                    <Markdown text={r.content} />
                  </div>
                  {r.latency_ms != null ? <p className="text-[11px] text-ink-3">{r.latency_ms} ms</p> : null}
                </>
              ) : (
                <Alert tone="danger">{r.error ?? "This lane failed."}</Alert>
              )}
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
