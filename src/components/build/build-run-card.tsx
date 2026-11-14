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
import { readBuildRun, resumeBuildRun } from "@/lib/client/build-runner";
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
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
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
    if (!runId || !run || (run.status !== "running" && run.status !== "requested" && run.status !== "paused")) return;
    if (resuming) return; // the resume stream is the source
    if (liveRun && (liveRun.status === "running" || liveRun.status === "requested")) return; // the stream is the source
    const timer = setInterval(async () => {
      if (polls.current++ > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      const next = await readBuildRun(runId);
      if (!next) return;
      setStored(next);
      if (next.status === "succeeded" || next.status === "failed" || next.status === "awaiting_input" || next.status === "cancelled") clearInterval(timer);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [runId, run?.status, liveRun, resuming]);

  const hydrate = useCallback(() => {
    if (hydrated || stored || !runId) return;
    setHydrated(true);
    void refresh();
  }, [hydrated, refresh, runId, stored]);

  // A paused or interrupted run is continued in place: same run, same chat,
  // same project. Nothing is re-sent and no new message is created.
  const continueRun = useCallback(async () => {
    if (!runId || resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      const result = await resumeBuildRun(runId, { onRun: (next) => setStored(next) });
      if (result.run) setStored(result.run);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setResumeError(code === "ALREADY_RESUMING" ? "This build is already continuing." : code === "CONTINUATION_LIMIT" ? "This build was continued the maximum number of times. Its files are saved in the project." : code === "NOTHING_TO_RESUME" ? "There is no saved progress to continue from." : "The build could not be continued. Try again in a moment.");
      void refresh();
    } finally {
      setResuming(false);
    }
  }, [refresh, resuming, runId]);

  // A stored snapshot does not carry the continuation record: read the run.
  useEffect(() => {
    if (snapshot && !liveRun && !stored && (snapshot.status === "paused" || snapshot.status === "failed")) void refresh();
  }, [liveRun, refresh, snapshot, stored]);

  if (!run) return null;
  const streaming = Boolean(liveRun && busy);
  const canContinue = !streaming && !resuming && run.continuation?.available === true && (run.status === "paused" || run.status === "failed");
  return (
    <>
      <DeploymentRow
        run={run}
        overview={overview}
        onOpenWorkspace={onOpenWorkspace}
        onRetry={canContinue ? undefined : onRetry}
        busy={busy || resuming}
        onRequestDetails={hydrate}
      />
      {canContinue || resumeError ? (
        <div className="mt-1.5 flex max-w-xl flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
          <span className="min-w-0 flex-1">{resumeError ?? run.continuation?.message}</span>
          {canContinue ? (
            <button type="button" onClick={() => void continueRun()} className="shrink-0 rounded-md border border-accent/40 bg-accent-soft px-2.5 py-1 text-[11.5px] font-semibold text-ink hover:border-accent">
              {run.continuation?.phase === "publish" ? "Retry publish" : "Continue"}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
