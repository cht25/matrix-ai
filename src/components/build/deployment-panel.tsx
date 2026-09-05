"use client";

// =============================================================================
// Deployment panel (§16, §17, §18, §21, §36)
//
// The console for one project: real provider state, the environments the host
// actually supports, the deployment history with rollback only when the
// provider kept a snapshot, and the high-level logs. Nothing here is painted
// from a hopeful local flag — the panel re-reads the deployment overview after
// every action.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpCircle, Check, Eye, GitBranch, Globe2, History, Play, RefreshCcw, Rocket, ShieldCheck, TriangleAlert,
} from "lucide-react";
import type { DeploymentRow, ProjectDeploymentOverview, ValidationView } from "@/lib/deploy/provider";
import { supportedEnvironments } from "@/lib/deploy/provider";
import type { DeployEnvironmentId } from "@/lib/deploy/provider";
import type { BuildRun } from "@/lib/deploy/stages";
import { absoluteUrl, formatBytes, relativeTime, shortUrl } from "@/lib/deploy/format";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { BuildChecks, DeploymentLogsDisclosure, LogList, type LogRow } from "@/components/build/build-progress";
import { CopyLinkButton, OpenLiveSiteButton } from "@/components/build/deploy-card";
import { Alert, Button, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

export function DeploymentPanel({
  projectId,
  overview,
  run,
  busy,
  onRefresh,
  onDeploy,
  onPreview,
  onOpenFiles,
  onManageUrls,
}: {
  projectId: string;
  overview: ProjectDeploymentOverview | null;
  run: BuildRun | null;
  busy?: boolean;
  onRefresh: () => void;
  onDeploy: (options: { environment: DeployEnvironmentId; publish: boolean; allowOverride: boolean }) => void;
  onPreview: () => void;
  onOpenFiles: () => void;
  onManageUrls: () => void;
}) {
  const [validation, setValidation] = useState<ValidationView | null>(null);
  const [checking, setChecking] = useState(false);
  const [override, setOverride] = useState(false);
  const [environment, setEnvironment] = useState<DeployEnvironmentId>("production");
  const [error, setError] = useState<string | null>(null);

  const capabilities = overview?.capabilities;
  const environments = useMemo(() => (capabilities ? supportedEnvironments(capabilities) : []), [capabilities]);
  const liveUrl = overview?.is_live ? absoluteUrl(overview.live_url) : "";
  const primary = overview?.urls?.find((item) => item.primary && item.status === "active") ?? overview?.urls?.[0];

  useEffect(() => {
    if (!environments.some((item) => item.id === environment) && environments[0]) setEnvironment(environments[0].id);
  }, [environments, environment]);

  const validate = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setValidation(await rpc<ValidationView>("project_validate", { project_id: projectId }));
    } catch (err) {
      setError(describe(err, "MATRIX could not run the checks."));
    } finally {
      setChecking(false);
    }
  }, [projectId]);

  const statusTone =
    overview?.status === "live" ? "text-success" : overview?.status === "failed" ? "text-danger" : "text-accent";

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-surface">
        <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Rocket size={14} className="text-accent" />
          <p className="eyebrow flex-1 text-ink-3">Deployment</p>
          <button type="button" onClick={onRefresh} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-ink-2 hover:bg-surface-2" aria-label="Refresh deployment state">
            <RefreshCcw size={12} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </header>

        <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
          <Cell label="Status">
            <span className={cn("flex items-center gap-1.5 font-semibold text-ink", statusTone)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", overview?.status === "live" ? "bg-success" : overview?.status === "failed" ? "bg-danger" : "bg-accent")} aria-hidden="true" />
              {overview?.status_label ?? "Loading"}
            </span>
          </Cell>
          <Cell label="Build">
            <span className="font-semibold text-ink">
              {run
                ? run.status === "succeeded"
                  ? "Successful"
                  : run.status === "failed"
                    ? "Failed"
                    : "Running"
                : validation
                  ? validation.blocking
                    ? "Checks failing"
                    : "Checks passing"
                  : "Unknown"}
            </span>
          </Cell>
          <Cell label="Deployment">
            <span className="font-semibold text-ink">{overview?.is_live ? "Live" : overview?.status === "failed" ? "Failed" : "Not live"}</span>
          </Cell>
          <Cell label="Files">
            <span className="font-semibold text-ink">{overview?.files ?? 0}</span>
          </Cell>
          <Cell label="URLs">
            <span className="font-semibold text-ink">{overview?.urls?.filter((item) => item.status === "active").length ?? 0}</span>
          </Cell>
          <Cell label="Last deployed">
            <span className="font-semibold text-ink">{overview?.last_deployed_at ? relativeTime(overview.last_deployed_at) : "Never"}</span>
          </Cell>
        </dl>

        <div className="border-t border-border px-3.5 py-3">
          <p className="eyebrow text-ink-3">Primary URL</p>
          {liveUrl ? (
            <p className="mt-1 break-all font-mono text-[12.5px] text-ink">
              <a href={liveUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                {liveUrl}
              </a>
            </p>
          ) : primary ? (
            <p className="mt-1 break-all font-mono text-[12.5px] text-ink-3">
              {shortUrl(primary.url)} · {primary.status === "pending_dns" ? "waiting for DNS" : "not live"}
            </p>
          ) : (
            <p className="mt-1 text-[12.5px] text-ink-3">This project is not published yet.</p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <OpenLiveSiteButton url={liveUrl || null} label="Open" className="min-h-9" />
            <CopyLinkButton url={liveUrl} className="min-h-9" label="Copy URL" />
            <button type="button" onClick={onManageUrls} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink">
              <Globe2 size={12} /> Manage URLs
            </button>
            <button type="button" onClick={onOpenFiles} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink">
              <Eye size={12} /> View files
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-3.5">
        <p className="eyebrow text-ink-3">Deploy</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {environments.length ? (
            <div role="radiogroup" aria-label="Deployment environment" className="flex flex-wrap gap-1.5">
              {environments.map((item) => (
                <label key={item.id} className={cn("inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[12px]", item.id === environment ? "border-accent/50 bg-accent-soft text-ink" : "border-border text-ink-2")}>
                  <input
                    type="radio"
                    name="deploy-environment"
                    className="sr-only"
                    checked={item.id === environment}
                    onChange={() => setEnvironment(item.id)}
                  />
                  <span className={cn("h-1.5 w-1.5 rounded-full", item.id === environment ? "bg-accent" : "bg-ink-3/40")} aria-hidden="true" />
                  {item.label}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-ink-3">No deploy environments are available on this host.</p>
          )}
          <button type="button" onClick={onPreview} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink">
            <Play size={12} /> Preview
          </button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
          {environments.find((item) => item.id === environment)?.note ?? "Environments the hosting backend cannot provide are never listed."}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={() => onDeploy({ environment, publish: true, allowOverride: override })} disabled={busy}>
            {busy ? <Spinner /> : <Rocket size={15} />} Publish now
          </Button>
          <Button variant="outline" onClick={() => onDeploy({ environment, publish: false, allowOverride: false })} disabled={busy}>
            Build &amp; validate only
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-2">
            <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} className="h-3.5 w-3.5 accent-[var(--danger)]" />
            Publish even if checks fail
          </label>
        </div>
        {override ? (
          <Alert tone="warning">
            <span className="flex items-start gap-2">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              Publishing with failing checks is allowed by this host, and the deployment record is marked
              &ldquo;overridden&rdquo; so you can see exactly which release skipped validation.
            </span>
          </Alert>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-accent" />
          <p className="eyebrow flex-1 text-ink-3">Build validation</p>
          <button type="button" onClick={() => void validate()} disabled={checking} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-accent hover:bg-surface-2">
            {checking ? <Spinner className="h-3 w-3" /> : <Check size={12} />} Run checks
          </button>
        </div>
        {validation ? (
          <BuildChecks
            checks={validation.checks}
            onFix={validation.blocking ? () => onDeploy({ environment, publish: false, allowOverride: false }) : undefined}
            onViewError={validation.blocking ? onOpenFiles : undefined}
            fixDisabled={busy}
          />
        ) : (
          <p className="mt-2 text-[12px] text-ink-3">
            Run the checks to see the real verdict for dependencies, syntax, build, routes and assets before publishing.
          </p>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </section>

      <DeploymentHistory
        projectId={projectId}
        rows={overview?.deployments ?? []}
        rollbackSupported={Boolean(capabilities?.rollback)}
        onChanged={onRefresh}
      />

      <DeploymentLogsDisclosure
        lines={(overview?.deployments?.[0]?.log ?? []).map<LogRow>((entry) => ({ at: entry.at, step: entry.step, detail: entry.detail }))}
        label="Deployment logs — latest"
      />
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface px-3.5 py-2.5">
      <dt className="eyebrow text-[9.5px] text-ink-3">{label}</dt>
      <dd className="mt-1 text-[12.5px]">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §18 deployment history
// ---------------------------------------------------------------------------

export function DeploymentHistory({
  projectId,
  rows,
  rollbackSupported,
  onChanged,
}: {
  projectId: string;
  rows: DeploymentRow[];
  rollbackSupported: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rollback(row: DeploymentRow) {
    if (!confirm(`Deploy v${row.version} again? The live site will serve those files.`)) return;
    setBusyId(row.id);
    setError(null);
    try {
      await rpc("deployment_rollback", { project_id: projectId, deployment_id: row.id });
      onChanged();
    } catch (err) {
      setError(describe(err, "Rollback failed on this host."));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleLogs(row: DeploymentRow) {
    if (expanded === row.id) {
      setExpanded(null);
      return;
    }
    setExpanded(row.id);
    if (logs[row.id]) return;
    try {
      const result = await rpc<{ log: LogRow[] }>("deployment_logs", { project_id: projectId, deployment_id: row.id });
      setLogs((current) => ({ ...current, [row.id]: result.log ?? [] }));
    } catch {
      setLogs((current) => ({ ...current, [row.id]: row.log.map((entry) => ({ at: entry.at, step: entry.step, detail: entry.detail })) }));
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <History size={14} className="text-accent" />
        <p className="eyebrow flex-1 text-ink-3">Deployments</p>
        <span className="text-[11px] text-ink-3">{rows.length} recorded</span>
      </header>
      {error ? <div className="px-3.5 pt-3"><Alert tone="danger">{error}</Alert></div> : null}
      {rows.length ? (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] text-ink-2">v{row.version}</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
                    row.status === "live"
                      ? "border-success/40 bg-success-soft text-success"
                      : row.status === "failed"
                        ? "border-danger/40 bg-danger-soft text-danger"
                        : "border-border text-ink-3",
                  )}
                >
                  {row.status === "live" ? "● Live" : row.status === "failed" ? "✕ Failed" : "○ " + row.status}
                </span>
                <span className="text-[11.5px] text-ink-3">{relativeTime(row.created_at)}</span>
                <span className="text-[11.5px] text-ink-3">· {row.files} files · {formatBytes(row.bytes)}</span>
                {row.overridden ? <span className="rounded-full border border-warning/40 bg-warning-soft px-2 py-0.5 text-[10px] text-warning">checks overridden</span> : null}
                <span className="ml-auto flex flex-wrap items-center gap-1">
                  {row.status === "live" && row.public_url ? (
                    <a href={absoluteUrl(row.public_url)} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] font-medium text-accent hover:bg-surface-2">
                      <Globe2 size={11} /> Open
                    </a>
                  ) : null}
                  <button type="button" onClick={() => void toggleLogs(row)} className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] text-ink-2 hover:bg-surface-2">
                    Logs
                  </button>
                  {rollbackSupported && row.rollback_available && row.status !== "live" ? (
                    <button
                      type="button"
                      onClick={() => void rollback(row)}
                      disabled={busyId === row.id}
                      className="inline-flex min-h-7 items-center gap-1 rounded-lg border border-border px-2 text-[11.5px] font-medium text-ink-2 hover:border-accent/50 hover:text-ink disabled:opacity-50"
                    >
                      {busyId === row.id ? <Spinner className="h-3 w-3" /> : <ArrowUpCircle size={11} />} Rollback
                    </button>
                  ) : null}
                </span>
              </div>
              {expanded === row.id ? (
                <div className="mt-2">
                  <LogList lines={logs[row.id] ?? row.log.map((entry) => ({ at: entry.at, step: entry.step, detail: entry.detail }))} maxHeight={160} />
                  {!rollbackSupported || !row.rollback_available ? (
                    <p className="mt-1 text-[11px] text-ink-3">
                      {row.status === "live"
                        ? "This is the live release."
                        : rollbackSupported
                          ? "No snapshot was retained for this release (it exceeded the storage budget), so rollback is unavailable."
                          : "This hosting backend does not expose rollback."}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3.5 py-3 text-[12px] text-ink-3">
          <GitBranch size={12} className="mr-1 inline" />
          No deployments yet. Publish to create the first one.
        </p>
      )}
    </section>
  );
}

export function describe(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[MATRIX]", view.code, err);
  return err instanceof RpcCallError && err.code === "BUILD_FAILED" ? fallback : `${view.title} — ${view.detail}`;
}
