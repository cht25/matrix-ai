"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui-interactive";
import { Button, Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";

// Real health only — every field below comes from GET /api/health, which
// performs live probes. Nothing here is simulated.
type Health = {
  ok: boolean;
  firebase: string;
  webConfig?: string;
  cloudinary: string;
  ai: string;
  codingAi: string;
  codingProvider?: string;
  codingModel?: string;
  checkedAt: string;
};

type Tone = "ok" | "warn" | "bad" | "idle";

function toneOf(value: string | undefined): Tone {
  switch (value) {
    case "reachable":
    case "online":
    case "valid":
      return "ok";
    case "unknown":
    case "not-configured":
      return "idle";
    case "unavailable":
      return "warn";
    default:
      return value ? "bad" : "idle";
  }
}

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-danger",
  idle: "bg-ink-3",
};

const HUMAN: Record<string, string> = {
  reachable: "Healthy",
  unreachable: "Unreachable",
  online: "Online",
  unavailable: "Degraded",
  unknown: "Not probed",
  "not-configured": "Not configured",
  valid: "Valid",
  "invalid-key": "Invalid web API key",
  "project-mismatch": "Project mismatch",
};

function human(value: string | undefined): string {
  if (!value) return "Unknown";
  return HUMAN[value] ?? value;
}

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth((await res.json()) as Health);
      setFailed(false);
    } catch (err) {
      console.error("[MATRIX admin] health probe failed", err);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { health, failed, refresh };
}

/** Compact global status indicator; opens the full system health panel. */
export function SystemStatusPill() {
  const { health, failed, refresh } = useHealth();
  const [open, setOpen] = useState(false);

  const tone: Tone = failed ? "bad" : !health ? "idle" : health.ok ? (toneOf(health.ai) === "ok" ? "ok" : "warn") : "bad";
  const label = failed
    ? "Status unavailable"
    : !health
      ? "Checking systems…"
      : health.ok
        ? toneOf(health.ai) === "ok" ? "All systems operational" : "Partially degraded"
        : "Service disruption";

  const rows = health
    ? [
        { name: "AI provider", value: health.ai },
        { name: "Coding AI", value: health.codingAi },
        { name: "Database", value: health.firebase },
        { name: "Web auth config", value: health.webConfig },
        { name: "Media storage", value: health.cloudinary },
      ]
    : [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`System status: ${label}. Open system health.`}
        className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-border-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span aria-hidden className={cn("h-2 w-2 rounded-full pulse-dot", TONE_DOT[tone])} />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">Status</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="System health"
        description="Live probes against the services MATRIX depends on."
        size="sm"
        footer={<Button variant="outline" onClick={() => void refresh()}>Re-check</Button>}
      >
        {!health && !failed ? (
          <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : failed ? (
          <p className="text-sm text-ink-2">The health endpoint could not be reached from this browser. Check your connection and re-check.</p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {rows.map((r) => {
                const t = toneOf(r.value);
                return (
                  <li key={r.name} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
                    <span className="text-ink-2">{r.name}</span>
                    <span className="inline-flex items-center gap-2 font-mono text-[11px] text-ink-3">
                      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[t])} />
                      {human(r.value)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {health?.codingProvider ? (
              <p className="mt-3 font-mono text-[11px] text-ink-3">
                coding route: {health.codingProvider} · {health.codingModel}
              </p>
            ) : null}
            <p className="mt-1 font-mono text-[11px] text-ink-3">checked {health ? new Date(health.checkedAt).toLocaleTimeString() : "—"}</p>
          </>
        )}
      </Modal>
    </>
  );
}

/**
 * MATRIX SYSTEM PULSE — compact live panel for the overview dashboard.
 * Runtime values are supplied by the server (real counts); service state comes
 * from the live health probe. No placeholder numbers.
 */
export function SystemPulse({ metrics }: { metrics: { label: string; value: string }[] }) {
  const { health, failed } = useHealth();
  const cells = [
    { label: "AI", value: failed ? "Unknown" : human(health?.ai), tone: failed ? "bad" : toneOf(health?.ai) },
    { label: "Database", value: failed ? "Unknown" : human(health?.firebase), tone: failed ? "bad" : toneOf(health?.firebase) },
    { label: "Media", value: failed ? "Unknown" : human(health?.cloudinary), tone: failed ? "bad" : toneOf(health?.cloudinary) },
  ] as { label: string; value: string; tone: Tone }[];

  return (
    <section aria-label="Matrix system pulse" className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">Matrix system pulse</p>
        <span className="font-mono text-[10px] text-ink-3">live</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="rounded-xl border border-border bg-surface-2 px-3 py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{c.label}</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink">
              <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[c.tone])} />
              {health || failed ? c.value : "…"}
            </p>
          </div>
        ))}
        {metrics.map((m) => (
          <div key={m.label} className="rounded-xl border border-border bg-surface-2 px-3 py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{m.label}</p>
            <p className="mt-1 text-sm font-medium text-ink">{m.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
