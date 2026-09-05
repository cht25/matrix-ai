"use client";

// =============================================================================
// Chat-side build card (§3, §4, §22, §24, §39)
//
// Owns exactly one thing: presenting the *stored* state of a build run.
//
//   • While the run is live, the caller hands down the streamed run.
//   • After a reload the card re-reads `/api/build` (through build_run_get) and
//     polls while the server still reports it running.
//   • Details are hydrated lazily, so a long chat does not fire a read per
//     message.
//
// Nothing here can mark a project published: `live` only appears when the
// persisted run says the provider returned a live deployment.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BuildRun, BuildRunSnapshot } from "@/lib/deploy/stages";
import { runFromSnapshot } from "@/lib/deploy/stages";
import { normalizeStatus } from "@/lib/deploy/status";
import { readBuildRun } from "@/lib/client/build-runner";
import { DeploymentRow } from "@/components/build/deploy-card";
import type { ProjectDeploymentOverview } from "@/lib/deploy/provider";

const POLL_MS = 3_000;
const MAX_POLLS = 60;

export type ChatDeploymentMeta = {
  id: string;
  status: string;
  url: string | null;
  slug: string | null;
  environment: string;
  files: number;
};

export function BuildRunCard({
  snapshot,
  deployment,
  liveRun,
  overview,
  onOpenWorkspace,
  onRetry,
  busy,
}: {
  snapshot?: BuildRunSnapshot | null;
  deployment?: ChatDeploymentMeta | null;
  /** The run currently being streamed (latest turn only). */
  liveRun?: BuildRun | null;
  overview?: ProjectDeploymentOverview | null;
  onOpenWorkspace?: () => void;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const [stored, setStored] = useState<BuildRun | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const polls = useRef(0);
  const runId = snapshot?.run_id ?? liveRun?.id ?? null;

  // A persisted run snapshot carries the run id where the deployment id
  // belongs; the message metadata knows the real one, so merge them here.
  const run: BuildRun | null = useMemo(() => {
    const base = liveRun ?? stored ?? (snapshot ? runFromSnapshot(snapshot, Date.now()) : null);
    if (!base) return null;
    if (!deployment?.id) return base;
    return {
      ...base,
      deployment: {
        id: deployment.id,
        status: normalizeStatus(deployment.status),
        url: deployment.status === "live" ? (deployment.url ?? base.deployment?.url ?? null) : (base.deployment?.url ?? null),
        slug: deployment.slug ?? (base.deployment?.slug ?? null),
        environment: deployment.environment === "preview" ? "preview" : "production",
        rollbackAvailable: base.deployment?.rollbackAvailable ?? false,
        overridden: base.deployment?.overridden ?? false,
        error: base.deployment?.error ?? null,
      },
    };
  }, [deployment, liveRun, snapshot, stored]);

  const refresh = useCallback(async () => {
    if (!runId) return;
    const next = await readBuildRun(runId);
    if (next) setStored(next);
  }, [runId]);

  // Poll only while the stored state is genuinely in flight.
  useEffect(() => {
    if (!runId || !run || (run.status !== "running" && run.status !== "requested")) return;
    if (liveRun && (liveRun.status === "running" || liveRun.status === "requested")) return; // the stream is the source
    const timer = setInterval(async () => {
      if (polls.current++ > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      const next = await readBuildRun(runId);
      if (!next) return;
      setStored(next);
      if (next.status === "succeeded" || next.status === "failed") clearInterval(timer);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [runId, run?.status, liveRun]);

  const hydrate = useCallback(() => {
    if (hydrated || stored || !runId) return;
    setHydrated(true);
    void refresh();
  }, [hydrated, refresh, runId, stored]);

  if (!run) return null;
  return (
    <DeploymentRow
      run={run}
      overview={overview}
      onOpenWorkspace={onOpenWorkspace}
      onRetry={onRetry}
      busy={busy}
      onRequestDetails={hydrate}
    />
  );
}
