"use client";

// =============================================================================
// Deployment results in chat (§5, §6, §22, §23, §29, §30, §37)
//
//   Response → Project → Build → Deployment
//
// Each section collapses on its own and the chat row stays one line once the
// deployment is finished. The URL rendered here is always the one the provider
// returned — when there is no live deployment there is no link, no "Published"
// and no popup, only the failing state with [Retry] / [View logs].
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  Check, ChevronDown, Copy, ExternalLink, FileCode2, FolderTree, Globe2, Rocket, Terminal, X,
} from "lucide-react";
import type { BuildRun } from "@/lib/deploy/stages";
import { buildRunCopy, stageProgress } from "@/lib/deploy/stages";
import type { ProjectDeploymentOverview } from "@/lib/deploy/provider";
import { copyToClipboard, formatBytes, pluralize, relativeTime, shortUrl } from "@/lib/deploy/format";
import { BuildChecks, ChangeSummary, DeploymentLogsDisclosure } from "@/components/build/build-progress";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui";

// ---------------------------------------------------------------------------
// Copy-link button (✓ Link copied)
// ---------------------------------------------------------------------------

export function CopyLinkButton({ url, className, label = "Copy link" }: { url: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = useCallback(async () => {
    const ok = await copyToClipboard(url);
    setCopied(ok ? "copied" : "failed");
    setTimeout(() => setCopied("idle"), 2000);
  }, [url]);
  if (!url) return null;
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium transition-colors",
        copied === "copied" ? "border-success/50 bg-success-soft text-success" : "text-ink-2 hover:border-accent/50 hover:text-ink",
        className,
      )}
    >
      {copied === "copied" ? <Check size={12} /> : <Copy size={12} />}
      {copied === "copied" ? "Link copied" : copied === "failed" ? "Press ⌘/Ctrl+C" : label}
    </button>
  );
}

export function OpenLiveSiteButton({ url, className, label = "Open live site" }: { url: string | null; className?: string; label?: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-hover",
        className,
      )}
    >
      <ExternalLink size={13} /> {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Chat row — one line when finished, expandable for the full console (§22)
// ---------------------------------------------------------------------------

export function DeploymentRow({
  run,
  overview,
  onOpenWorkspace,
  onRetry,
  onManageUrls,
  onRequestDetails,
  busy,
}: {
  run: BuildRun | null;
  overview?: ProjectDeploymentOverview | null;
  onOpenWorkspace?: () => void;
  onRetry?: () => void;
  onManageUrls?: () => void;
  /** Called the first time the details are expanded (lazy hydrating read). */
  onRequestDetails?: () => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const requested = useCallback(() => {
    setOpen((value) => {
      const next = !value;
      if (next) onRequestDetails?.();
      return next;
    });
  }, [onRequestDetails]);
  if (!run) return null;
  const copy = buildRunCopy(run);
  const progress = stageProgress(run);
  const urls = overview?.urls?.filter((item) => item.status === "active") ?? [];
  const liveUrl = copy.liveUrl ?? overview?.live_url ?? null;
  const failed = run.status === "failed";

  return (
    <div className="mt-3 max-w-xl overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-lg border text-[13px]",
            copy.tone === "success"
              ? "border-success/45 bg-success-soft text-success"
              : copy.tone === "danger"
                ? "border-danger/45 bg-danger-soft text-danger"
                : "border-accent/40 bg-accent-soft text-accent",
          )}
          aria-hidden="true"
        >
          {copy.glyph === "●" ? <Spinner className="h-3.5 w-3.5" /> : copy.glyph === "✓" ? <Check size={14} /> : failed ? <X size={14} /> : <Globe2 size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-ink">{copy.title}</p>
          <p className="truncate text-[11px] text-ink-3">
            {liveUrl ? (
              <a href={liveUrl} target="_blank" rel="noreferrer noopener" className="font-mono text-accent hover:underline">
                {shortUrl(liveUrl, 44)}
              </a>
            ) : (
              copy.detail
            )}
          </p>
        </div>
        {liveUrl ? <OpenLiveSiteButton url={liveUrl} /> : null}
        {liveUrl ? <CopyLinkButton url={liveUrl} /> : null}
        {failed && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="inline-flex min-h-9 items-center rounded-lg border border-danger/45 bg-danger-soft px-2.5 text-[12px] font-semibold text-danger hover:opacity-90 disabled:opacity-50"
          >
            Retry
          </button>
        ) : null}
        <button
          type="button"
          onClick={requested}
          className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[11.5px] font-medium text-ink-2 hover:text-ink"
          aria-expanded={open}
        >
          Deployment details
          <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Files" value={String(run.fileCount || overview?.files || 0)} />
            <Stat label="Build" value={run.status === "succeeded" ? "Successful" : run.status === "failed" ? "Failed" : "Running"} />
            <Stat label="Deployment" value={overview ? overview.status_label : progress.activeLabel} />
            <Stat label="URLs" value={String(urls.length || (liveUrl ? 1 : 0))} />
            {overview?.deployments?.[0]?.version ? <Stat label="Version" value={`v${overview.deployments[0].version}`} /> : null}
            {overview?.last_deployed_at ? <Stat label="Deployed" value={relativeTime(overview.last_deployed_at)} /> : null}
            {overview?.deployments?.[0]?.bytes ? <Stat label="Uploaded" value={formatBytes(overview.deployments[0].bytes)} /> : null}
            {run.attempts ? <Stat label="Auto-fix" value={`${run.attempts}/${run.maxAttempts}`} /> : null}
          </dl>

          {run.changes.length ? <ChangeSummary changes={run.changes} defaultOpen /> : null}
          {run.validation ? <BuildChecks checks={run.validation} /> : null}
          <DeploymentLogsDisclosure
            lines={[
              ...run.logs.map((line) => ({ at: String(line.at), step: line.stage ?? "info", detail: line.message })),
              ...(overview?.deployments?.[0]?.log ?? []).map((entry) => ({ at: entry.at, step: entry.step, detail: entry.detail })),
            ]}
            label="Build & deployment logs"
          />
          <div className="flex flex-wrap gap-2">
            {onOpenWorkspace ? (
              <button type="button" onClick={onOpenWorkspace} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink">
                <FolderTree size={12} /> View files
              </button>
            ) : null}
            {onManageUrls ? (
              <button type="button" onClick={onManageUrls} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink">
                <Globe2 size={12} /> Manage URLs
              </button>
            ) : null}
            {overview?.project_id ? (
              <a
                href={`/projects/${overview.project_id}`}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink"
              >
                <FileCode2 size={12} /> Open project workspace
              </a>
            ) : null}
          </div>
          {liveUrl ? (
            <p className="text-[11px] text-ink-3">
              {pluralize(urls.length, "address")} serving this deployment · {overview?.capabilities?.label ?? "MATRIX hosting"}
            </p>
          ) : (
            <p className="text-[11px] text-ink-3">Nothing is public yet — MATRIX only shows a link once the host reports the deployment live.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/70 px-2.5 py-1.5">
      <dt className="eyebrow text-[9.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate text-[12.5px] font-semibold text-ink">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §5 / §29 / §30 — the publish popup
// ---------------------------------------------------------------------------

export function DeploySuccessPopup({
  run,
  url,
  files,
  environment = "Production",
  onClose,
  onViewProject,
  onDeploymentDetails,
  onAssets,
}: {
  run: BuildRun | null;
  url: string | null;
  files: number;
  environment?: string;
  onClose: () => void;
  onViewProject?: () => void;
  onDeploymentDetails?: () => void;
  onAssets?: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only a live deployment may open this card. A run that is merely "sent"
  // never produces a success popup (§32, §39).
  if (!run || run.status !== "succeeded" || !url) return null;
  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Project published">
      <button type="button" className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} aria-label="Dismiss" tabIndex={-1} />
      <div
        className="fade-in relative w-full max-w-md overflow-hidden rounded-2xl border border-success/35 bg-surface shadow-[0_30px_80px_-20px_rgba(0,255,163,0.25)]"
        style={{ background: "linear-gradient(180deg, rgba(0,255,163,0.07), transparent 42%), var(--surface)" }}
      >
        <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-success/40 bg-success-soft text-success" aria-hidden="true">
            <Check size={18} strokeWidth={2.4} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow text-ink-3">Matrix deploy</p>
            <h2 className="truncate text-[15px] font-semibold text-ink">Project published</h2>
            <p className="mt-0.5 text-[12px] text-ink-2">Your project is now live.</p>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3.5">
          <div className="rounded-xl border border-border bg-bg/80 px-3 py-2.5">
            <p className="text-[11px] text-ink-3">Live URL</p>
            <a href={url} target="_blank" rel="noreferrer noopener" className="mt-0.5 block break-all font-mono text-[12.5px] font-semibold text-accent hover:underline">
              {url}
            </a>
          </div>

          <div className="flex flex-wrap gap-2">
            <OpenLiveSiteButton url={url} className="min-h-10 flex-1 justify-center" />
            <CopyLinkButton url={url} className="min-h-10 px-3" />
          </div>

          <dl className="grid grid-cols-2 gap-2 text-[12px]">
            <div className="rounded-lg border border-border bg-surface-2/70 px-2.5 py-1.5">
              <dt className="eyebrow text-[9.5px] text-ink-3">Deployment</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 font-semibold text-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                {environment}
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-surface-2/70 px-2.5 py-1.5">
              <dt className="eyebrow text-[9.5px] text-ink-3">Build</dt>
              <dd className="mt-0.5 font-semibold text-success">Successful</dd>
            </div>
            <div className="rounded-lg border border-border bg-surface-2/70 px-2.5 py-1.5">
              <dt className="eyebrow text-[9.5px] text-ink-3">Files</dt>
              <dd className="mt-0.5 font-semibold text-ink">{files}</dd>
            </div>
            <div className="rounded-lg border border-border bg-surface-2/70 px-2.5 py-1.5">
              <dt className="eyebrow text-[9.5px] text-ink-3">Hosting</dt>
              <dd className="mt-0.5 truncate font-semibold text-ink">{run.deployment?.slug ? `/s/${run.deployment.slug}` : "MATRIX"}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {onViewProject ? (
              <button type="button" onClick={onViewProject} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:border-accent/50 hover:text-ink">
                <Rocket size={12} /> View project
              </button>
            ) : null}
            {onDeploymentDetails ? (
              <button type="button" onClick={onDeploymentDetails} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:border-accent/50 hover:text-ink">
                <Terminal size={12} /> Deployment details
              </button>
            ) : null}
            {onAssets ? (
              <button type="button" onClick={onAssets} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] font-medium text-ink-2 hover:border-accent/50 hover:text-ink">
                <Globe2 size={12} /> Assets &amp; URLs
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
