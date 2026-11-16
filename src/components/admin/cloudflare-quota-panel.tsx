"use client";

// Cloudflare Workers AI — free-quota dashboard (Admin → AI → Usage).
//
// Shows ACTUAL usage for the current UTC day: Cloudflare's own Neuron count
// when the API token may read analytics, otherwise the request count with an
// explicit "actual Neuron usage unavailable" note. Nothing here is estimated
// from tokens, and no credential is ever fetched or displayed.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Gauge } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { Alert, Card, Spinner } from "@/components/ui";

export type CloudflareQuota = {
  configured: boolean;
  model: string | null;
  date: string;
  requests: number;
  failedRequests: number;
  neurons: number | null;
  neuronsSource: "graphql" | "response" | "unavailable";
  budget: number;
  safetyReserve: number;
  effectiveBudget: number;
  requestBudget: number;
  remainingNeurons: number | null;
  exhausted: boolean;
  exhaustionReason: string | null;
  warning: string | null;
  resetsAt: string;
};

function percent(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function sourceLabel(source: CloudflareQuota["neuronsSource"]): string {
  if (source === "graphql") return "actual Neuron usage from Cloudflare analytics";
  if (source === "response") return "Neuron usage reported by the API on each response";
  return "actual Neuron usage unavailable — request safety budget in effect";
}

export function CloudflareQuotaPanel() {
  const [quota, setQuota] = useState<CloudflareQuota | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    rpc<CloudflareQuota>("admin_cloudflare_quota")
      .then(setQuota)
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (failed) {
    return (
      <Card className="space-y-2">
        <h2 className="font-display text-lg font-semibold text-ink">Cloudflare Workers AI quota</h2>
        <p className="text-sm text-ink-2">The quota report could not be loaded. It re-checks on the next visit.</p>
        <button type="button" className="btn btn-outline" onClick={load}>
          Retry
        </button>
      </Card>
    );
  }

  if (!quota) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-ink-3">
          <Spinner /> Loading Cloudflare quota…
        </div>
      </Card>
    );
  }

  if (!quota.configured) {
    return (
      <Card className="space-y-1.5">
        <h2 className="font-display text-lg font-semibold text-ink">Cloudflare Workers AI quota</h2>
        <p className="text-sm text-ink-2">
          Not configured. Set <span className="font-mono text-xs">CLOUDFLARE_ACCOUNT_ID</span> and{" "}
          <span className="font-mono text-xs">CLOUDFLARE_API_TOKEN</span> on the server (Workers AI → Read/Edit
          permissions) to serve chat, advanced chat and Agent Mode from Cloudflare with automatic fallback to the
          existing providers.
        </p>
      </Card>
    );
  }

  const usingNeurons = quota.neurons !== null;
  const used = usingNeurons ? quota.neurons! : quota.requests;
  const max = usingNeurons ? quota.effectiveBudget : quota.requestBudget;
  const usedPercent = percent(used, max);
  const resetTime = new Date(quota.resetsAt).toISOString().slice(11, 16);

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-ink">Cloudflare Workers AI quota</h2>
        <span className="font-mono text-[11px] text-ink-3">
          {quota.date} · resets {resetTime} UTC
        </span>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {quota.exhausted ? (
          <span className="inline-flex items-center gap-1.5 text-danger">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Quota exhausted — requests continue on another
            provider
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Within today&apos;s free budget
          </span>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-ink-2">
          <span className="inline-flex items-center gap-1">
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            {usingNeurons ? `${used.toLocaleString()} / ${max.toLocaleString()} Neurons` : `${used} / ${max} requests`}
          </span>
          <span>{usedPercent}%</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={usedPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Cloudflare quota used today"
        >
          <div
            className={quota.exhausted ? "h-full rounded-full bg-danger" : usedPercent >= 80 ? "h-full rounded-full bg-warning" : "h-full rounded-full bg-accent"}
            style={{ width: `${Math.max(2, usedPercent)}%` }}
          />
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
          Model {quota.model ?? "—"} · {sourceLabel(quota.neuronsSource)} · daily budget {quota.budget.toLocaleString()}{" "}
          Neurons with a {quota.safetyReserve.toLocaleString()}-Neuron safety reserve
          {!usingNeurons ? ` · request safety budget ${quota.requestBudget}/day` : ""}.
        </p>
      </div>

      {quota.warning ? <Alert tone={quota.exhausted ? "danger" : "warning"}>{quota.warning}</Alert> : null}

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <dt className="text-ink-3">Requests today</dt>
          <dd className="font-mono text-ink">{quota.requests}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <dt className="text-ink-3">Failed</dt>
          <dd className="font-mono text-ink">{quota.failedRequests}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <dt className="text-ink-3">Neurons used</dt>
          <dd className="font-mono text-ink">{quota.neurons === null ? "unavailable" : quota.neurons.toLocaleString()}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 px-3 py-2">
          <dt className="text-ink-3">Remaining</dt>
          <dd className="font-mono text-ink">{quota.remainingNeurons === null ? "—" : quota.remainingNeurons.toLocaleString()}</dd>
        </div>
      </dl>
    </Card>
  );
}
