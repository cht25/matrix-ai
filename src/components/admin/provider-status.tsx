"use client";

// Provider status dashboard. Every row reflects a REAL probe performed by
// GET /api/health — text AI, image generation, agent runtime and the database
// are each checked live. Nothing here is hard-coded to "Connected".

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card, Spinner } from "@/components/ui";

type Health = {
  ok: boolean;
  firebase: string;
  ai: string;
  codingAi: string;
  codingProvider?: string;
  codingModel?: string;
  imageAi: string;
  imageProvider?: string;
  imageModel?: string;
  checkedAt: string;
};

type Row = { label: string; state: "ok" | "warn" | "down" | "idle"; detail: string };

function rowFor(label: string, value: string | undefined, detail = ""): Row {
  switch (value) {
    case "online":
    case "reachable":
      return { label, state: "ok", detail: detail || "Connected" };
    case "unavailable":
    case "unreachable":
      return { label, state: "down", detail: "Connection failed" };
    case "not-configured":
      return { label, state: "idle", detail: "Not configured" };
    default:
      return { label, state: "warn", detail: "Unknown" };
  }
}

export function ProviderStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth((await res.json()) as Health);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows: Row[] = health
    ? [
        rowFor("Text AI", health.ai),
        rowFor(
          "Image generation",
          health.imageAi,
          health.imageAi === "online" ? `${health.imageProvider ?? "Provider"} connected` : "",
        ),
        rowFor("Agent runtime", health.codingAi, health.codingAi === "online" ? `${health.codingProvider ?? ""} ${health.codingModel ?? ""}`.trim() : ""),
        rowFor("Database", health.firebase, health.firebase === "reachable" ? "Healthy" : ""),
      ]
    : [];

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="eyebrow">AI providers</p>
          <h2 className="mt-1 text-lg font-semibold text-ink">Live status</h2>
        </div>
        <button type="button" onClick={() => void load()} className="icon-tile" aria-label="Refresh status" disabled={loading}>
          <RefreshCw size={15} strokeWidth={1.8} className={loading ? "spin" : undefined} />
        </button>
      </div>

      {loading && !health ? (
        <span className="inline-status"><Spinner /> Running live health checks…</span>
      ) : failed ? (
        <p className="text-sm text-danger">Health checks could not be reached. Try again.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm last:border-0">
              <span className="text-ink-2">{row.label}</span>
              <span className="flex items-center gap-2">
                <span className="status-dot" data-state={row.state === "idle" ? undefined : row.state} aria-hidden="true" />
                <span className={row.state === "ok" ? "text-success" : row.state === "down" ? "text-danger" : "text-ink-3"}>
                  {row.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {health?.checkedAt ? (
        <p className="mono text-xs text-ink-3">Checked {new Date(health.checkedAt).toLocaleTimeString()}</p>
      ) : null}
    </Card>
  );
}
