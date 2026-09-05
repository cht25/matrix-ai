"use client";

// =============================================================================
// MATRIX project workspace (§9–§13, §16–§21, §28, §31, §35, §36)
//
//   Project → Files → Build → Deploy → Manage
//
// The header is the project dashboard, the Files tab is a real multi-file
// editor with change summary, and the Deploy tab is the deployment console:
// provider capabilities, environments the host actually supports, URL aliases,
// history with rollback, logs and public variables.
//
// Publishing state is read from the persisted build run / deployment records —
// never from a local "it probably worked" flag.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, Copy, Download, FolderPlus, Globe, History, LayoutGrid, MonitorPlay, MoreHorizontal,
  Pencil, Plus, RefreshCcw, Rocket, Save, Settings2, SquareArrowOutUpRight, Trash2, Upload, X,
} from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { rpc, RpcCallError } from "@/lib/client/api";
import { pollBuildRun, streamBuildRun } from "@/lib/client/build-runner";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { looksLikeFrameworkProject, type ProjectFile } from "@/lib/projects/paths";
import type { ProjectDeploymentOverview } from "@/lib/deploy/provider";
import type { BuildRun } from "@/lib/deploy/stages";
import { absoluteUrl, pluralize, shortUrl } from "@/lib/deploy/format";
import { GithubConnection } from "@/components/github-connection";
import { FileTree } from "@/components/projects/file-tree";
import { FileEditor } from "@/components/projects/file-editor";
import { Alert, Button, Input, Menu, Spinner } from "@/components/ui";
import { BuildStatusCard, ChangeSummary } from "@/components/build/build-progress";
import { DeploymentPanel } from "@/components/build/deployment-panel";
import { AssetLibrary, EnvPanel, UrlManager } from "@/components/build/deployment-manage";
import { DeploySuccessPopup } from "@/components/build/deploy-card";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

type Tab = "preview" | "files" | "deploy" | "assets" | "github";

type ProjectMeta = {
  id: string;
  title: string;
  description?: string;
  live_slug: string | null;
  live_url: string | null;
  env_public: Record<string, string>;
  custom_domain: string;
  custom_domain_status: string;
  updated_at?: string;
};

type FileOp = { label: string; at: number };

export function ProjectWorkspace({
  projectId,
  initialFiles = [],
  conversationId,
  onTitle,
}: {
  projectId?: string;
  initialFiles?: AgentFile[];
  conversationId?: string | null;
  onTitle?: (title: string) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("preview");
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>(initialFiles.map((f) => ({ ...f, encoding: "utf8" as const })));
  const [openTabs, setOpenTabs] = useState<string[]>(initialFiles[0]?.path ? [initialFiles[0].path] : []);
  const [activePath, setActivePath] = useState(initialFiles[0]?.path ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [versions, setVersions] = useState<{ id: string; summary: string; created_at: string; source: string }[]>([]);
  const [overview, setOverview] = useState<ProjectDeploymentOverview | null>(null);
  const [run, setRun] = useState<BuildRun | null>(null);
  const [popup, setPopup] = useState<{ url: string; files: number } | null>(null);
  const [fileOps, setFileOps] = useState<FileOp[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runAbort = useRef<AbortController | null>(null);

  const active = files.find((f) => f.path === activePath) ?? files[0];
  const framework = looksLikeFrameworkProject(files.map((f) => f.path));
  const liveUrl = overview?.is_live ? absoluteUrl(overview.live_url) : "";
  const activeUrlCount = overview?.urls?.filter((item) => item.status === "active").length ?? 0;

  const recordOp = useCallback((label: string) => {
    setFileOps((current) => [...current, { label, at: Date.now() }].slice(-24));
  }, []);

  const load = useCallback(async (id: string) => {
    const data = await rpc<{ project: ProjectMeta; files: ProjectFile[] }>("project_get", { id });
    setProject(data.project);
    setFiles(data.files);
    setActivePath((cur) => (data.files.some((f) => f.path === cur) ? cur : (data.files[0]?.path ?? "")));
    setOpenTabs((current) => {
      const kept = current.filter((path) => data.files.some((file) => file.path === path));
      return kept.length ? kept : data.files.slice(0, 3).map((file) => file.path);
    });
    setSlug(data.project.live_slug ?? "");
    onTitle?.(data.project.title);
    const [vers, deployment] = await Promise.all([
      rpc<{ id: string; summary: string; created_at: string; source: string }[]>("project_version_list", { project_id: id }).catch(() => []),
      rpc<ProjectDeploymentOverview>("deployment_overview", { project_id: id }).catch(() => null),
    ]);
    setVersions(vers ?? []);
    if (deployment) setOverview(deployment);
    return data;
  }, [onTitle]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let id = projectId ?? "";
        let applyInitial = !projectId && initialFiles.length > 0;
        if (!projectId) {
          const proj = await rpc<{ id: string; file_count?: number }>("project_ensure", { conversation_id: conversationId ?? null, title: "Agent project" });
          id = proj.id;
          applyInitial = applyInitial && (proj.file_count ?? 0) === 0;
        }
        if (cancelled) return;
        if (applyInitial) {
          await rpc("project_apply_files", { project_id: id, files: initialFiles, source: "agent" }).catch(() => {});
          initialFiles.forEach((file) => recordOp(`Created ${file.path}`));
        }
        await load(id);
      } catch (err) {
        if (!cancelled) setMsg(friendly(err, "Could not open project."));
      }
    })();
    return () => {
      cancelled = true;
      runAbort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, conversationId]);

  // ------------------------------------------------------------------ files --
  function queueSave(nextFiles: ProjectFile[], path: string, content: string) {
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!project) return;
      void rpc("project_file_upsert", { project_id: project.id, path, content })
        .then(() => {
          setDirty(false);
          recordOp(`Updated ${path}`);
        })
        .catch(() => setMsg("Autosave failed — the change is only in this browser."));
    }, 450);
    setFiles(nextFiles);
  }

  function updateActive(content: string) {
    if (!active) return;
    const next = files.map((f) => (f.path === active.path ? { ...f, content } : f));
    queueSave(next, active.path, content);
  }

  function openFile(path: string) {
    setActivePath(path);
    setOpenTabs((current) => (current.includes(path) ? current : [...current, path]));
  }

  async function addFile() {
    if (!project) return;
    const path = window.prompt("New file path", "pages/about.html");
    if (!path) return;
    setBusy(true);
    try {
      await rpc("project_file_upsert", { project_id: project.id, path, content: "" });
      await load(project.id);
      openFile(path);
      recordOp(`Created ${path}`);
    } catch (err) {
      setMsg(friendly(err, "Could not create file."));
    } finally {
      setBusy(false);
    }
  }

  async function addFolder() {
    if (!project) return;
    const path = window.prompt("New folder path", "assets/icons");
    if (!path) return;
    setBusy(true);
    try {
      await rpc("project_create_directory", { project_id: project.id, path });
      await load(project.id);
      recordOp(`Added folder ${path}/`);
    } catch (err) {
      setMsg(friendly(err, "Could not create folder."));
    } finally {
      setBusy(false);
    }
  }

  async function renameFile(from: string, to: string) {
    if (!project || !to || to === from) return;
    setBusy(true);
    try {
      await rpc("project_file_rename", { project_id: project.id, from, to });
      await load(project.id);
      openFile(to);
      recordOp(`Renamed ${from} → ${to}`);
    } catch (err) {
      setMsg(friendly(err, "Could not rename file."));
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  }

  async function removeFile(path: string) {
    if (!project || !path) return;
    if (!window.confirm(`Delete ${path}?`)) return;
    setBusy(true);
    try {
      await rpc("project_file_delete", { project_id: project.id, path });
      setOpenTabs((current) => current.filter((item) => item !== path));
      await load(project.id);
      recordOp(`Deleted ${path}`);
    } catch (err) {
      setMsg(friendly(err, "Could not delete file."));
    } finally {
      setBusy(false);
    }
  }

  async function copyActive() {
    if (!active) return;
    const { copyToClipboard } = await import("@/lib/deploy/format");
    const ok = await copyToClipboard(active.content);
    toast(ok ? "File copied" : "Copy blocked by the browser");
  }

  // ----------------------------------------------------------- versions/logs --
  async function saveVersion() {
    if (!project) return;
    setBusy(true);
    try {
      await rpc("project_version_save", { project_id: project.id, source: "manual", summary: "Manual snapshot" });
      await load(project.id);
      setMsg("Version saved.");
      recordOp("Saved a snapshot of all files");
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    if (!project) return;
    if (!window.confirm("Restore this version? A snapshot of the current files is saved first.")) return;
    setBusy(true);
    try {
      await rpc("project_version_restore", { project_id: project.id, version_id: id });
      await load(project.id);
      recordOp("Restored a previous snapshot");
    } finally {
      setBusy(false);
    }
  }

  async function exportZip() {
    if (!project) return;
    const res = await fetch(`/api/projects/${project.id}/zip`, { credentials: "same-origin" });
    if (!res.ok) return setMsg("Export failed.");
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${project.title || "project"}.zip`;
    a.click();
    URL.revokeObjectURL(href);
  }

  async function importZip(file: File | undefined) {
    if (!project || !file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/projects/${project.id}/zip`, { method: "POST", body, credentials: "same-origin" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "IMPORT_FAILED");
      }
      const data = await load(project.id);
      recordOp(`Imported ${pluralize(data.files.length, "file")} from ZIP`);
      setMsg("ZIP imported.");
    } catch (err) {
      setMsg(friendly(err, "Import failed."));
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ build --
  /**
   * Run the pipeline for this project. `publish: false` builds + validates
   * only (§16 preview-first); `publish: true` continues into the host. The
   * stage list shown while it runs is the server's own state.
   */
  async function runPipeline(options: {
    build: boolean;
    publish: boolean;
    allowOverride: boolean;
    prompt?: string;
    environment?: "preview" | "production";
  }) {
    if (!project) return;
    setTab("deploy");
    setMsg(null);
    setBusy(true);
    setRun(null);
    const controller = new AbortController();
    runAbort.current = controller;
    try {
      const result = await streamBuildRun(
        {
          prompt: options.prompt ?? (options.build ? "Build the project described by its current files and make it publish-ready." : ""),
          projectId: project.id,
          conversationId: conversationId ?? null,
          actions: { build: options.build, publish: options.publish, preview: !options.publish },
          allowOverride: options.allowOverride,
          environment: options.environment,
        },
        { signal: controller.signal, onRun: (next) => setRun(next) },
      );
      setRun(result.run);
      // A disconnected stream must not leave "Publishing…" on screen: keep
      // reading the stored run until the server reports a terminal state.
      if (result.run && (result.run.status === "running" || result.run.status === "requested")) {
        void pollBuildRun(result.run.id, { onRun: (next) => setRun(next) }).finally(() => void load(project.id));
      }
      await load(project.id);
      if (result.run?.deployment?.status === "live" && result.run.deployment.url) {
        setPopup({ url: result.run.deployment.url, files: result.run.fileCount });
      }
    } catch (err) {
      setMsg(friendly(err, "The build could not be started."));
    } finally {
      setBusy(false);
      runAbort.current = null;
    }
  }

  const previewSrc = project ? `/api/projects/${project.id}/preview/` : "";

  const statusPill = useMemo(() => {
    const status = overview?.status ?? "none";
    if (status === "live") return { label: "Live", className: "border-success/45 bg-success-soft text-success", dot: "bg-success" };
    if (status === "failed") return { label: "Publishing failed", className: "border-danger/45 bg-danger-soft text-danger", dot: "bg-danger" };
    if (status === "building" || status === "deploying" || status === "queued") return { label: "Publishing...", className: "border-accent/45 bg-accent-soft text-accent", dot: "bg-accent animate-pulse" };
    return { label: "Not deployed", className: "border-border text-ink-3", dot: "bg-ink-3/40" };
  }, [overview?.status]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* §31 project dashboard header */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              key={project?.id ?? "title"}
              defaultValue={project?.title ?? "Agent project"}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (!project || !value || value === project.title) return;
                void rpc("project_update", { id: project.id, title: value }).then(() => setProject({ ...project, title: value }));
              }}
              className="min-w-0 max-w-[280px] truncate rounded-md bg-transparent text-[13.5px] font-semibold text-ink outline-none hover:bg-surface-2 focus:bg-surface-2"
              aria-label="Project title"
            />
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide", statusPill.className)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", statusPill.dot)} aria-hidden="true" />
              {statusPill.label}
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
            <span aria-hidden="true">·</span>
            <span>{overview?.deployments?.length ?? 0} deployment{(overview?.deployments?.length ?? 0) === 1 ? "" : "s"}</span>
            <span aria-hidden="true">·</span>
            <span>{activeUrlCount} URL{activeUrlCount === 1 ? "" : "s"}</span>
            {liveUrl ? (
              <>
                <span aria-hidden="true">·</span>
                <a href={liveUrl} target="_blank" rel="noreferrer noopener" className="truncate font-mono text-accent hover:underline">
                  {shortUrl(liveUrl, 40)}
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setTab("preview")} className="ws-tab" aria-pressed={tab === "preview"}>
            <MonitorPlay size={13} /> Preview
          </button>
          {liveUrl ? (
            <a href={liveUrl} target="_blank" rel="noreferrer noopener" className="ws-tab">
              <SquareArrowOutUpRight size={13} /> Open
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => void runPipeline({ build: false, publish: true, allowOverride: false })}
            disabled={busy}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11.5px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? <Spinner className="h-3 w-3" /> : <Rocket size={12} />} {liveUrl ? "Update live site" : "Deploy"}
          </button>
          <Menu
            trigger={
              <span className="ws-tab" role="button" aria-label="Project actions">
                <MoreHorizontal size={13} />
              </span>
            }
            items={[
              { label: "Settings & environment", icon: <Settings2 size={13} />, onClick: () => setTab("deploy") },
              { label: "Edit files", icon: <Pencil size={13} />, onClick: () => setTab("files") },
              { label: "Export ZIP", icon: <Download size={13} />, onClick: () => void exportZip() },
              { label: "Save snapshot", icon: <Save size={13} />, onClick: () => void saveVersion() },
            ]}
          />
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        {([
          { id: "preview" as const, label: "Live preview", icon: <MonitorPlay size={14} /> },
          { id: "files" as const, label: "Files", icon: <FolderPlus size={14} /> },
          { id: "deploy" as const, label: "Deploy", icon: <Globe size={14} /> },
          { id: "assets" as const, label: "Assets", icon: <LayoutGrid size={14} /> },
          { id: "github" as const, label: "GitHub", icon: <History size={14} /> },
        ]).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium", tab === item.id ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink")}
            aria-current={tab === item.id ? "page" : undefined}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 pr-1 text-[11px] text-ink-3">
          {dirty ? "Saving…" : project ? `${files.length} files` : ""}
          {run && (run.status === "running" || run.status === "requested") ? <span className="text-accent">build {run.stages.filter((s) => s.state === "completed" || s.state === "skipped").length}/{run.stages.length}</span> : null}
        </span>
      </div>

      {msg ? (
        <div className="px-3 pt-2">
          <Alert tone={msg.toLowerCase().includes("fail") ? "danger" : "info"}>{msg}</Alert>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "preview" ? (
          <div className="flex h-full flex-col">
            <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/60 px-3">
              <p className="text-xs text-ink-3">
                {framework
                  ? "Framework files detected — static preview uses index.html only."
                  : "Sandboxed preview of the saved project files (never the published copy)."}
              </p>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setPreviewKey((k) => k + 1)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-surface">
                  <RefreshCcw size={12} /> Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void runPipeline({ build: false, publish: false, allowOverride: false, prompt: "Validate the current project files and prepare a preview build." })}
                  disabled={busy}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-surface"
                >
                  <Check size={12} /> Run checks
                </button>
                <button
                  type="button"
                  onClick={() => void runPipeline({ build: false, publish: true, allowOverride: false })}
                  disabled={busy}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                >
                  {busy ? <Spinner /> : <Globe size={12} />} {liveUrl ? "Update live site" : "Publish"}
                </button>
                {liveUrl ? (
                  <a href={liveUrl} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-accent hover:bg-surface">
                    View live
                  </a>
                ) : null}
              </div>
            </div>
            {project ? (
              <iframe
                key={previewKey}
                title="Project live preview"
                sandbox="allow-scripts allow-forms allow-modals"
                src={`${previewSrc}?v=${previewKey}`}
                className="h-full w-full border-0 bg-white"
              />
            ) : (
              <div className="grid flex-1 place-items-center text-sm text-ink-3">
                <Spinner /> Opening project…
              </div>
            )}
          </div>
        ) : null}

        {tab === "files" ? (
          <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(150px,220px)_1fr]">
            <div className="min-h-0 overflow-y-auto border-b border-border bg-surface-2/45 md:border-b-0 md:border-r">
              <div className="flex gap-1 p-2">
                <button type="button" onClick={() => void addFile()} className="icon-tile" aria-label="New file" title="New file">
                  <Plus size={14} />
                </button>
                <button type="button" onClick={() => void addFolder()} className="icon-tile" aria-label="New folder" title="New folder">
                  <FolderPlus size={14} />
                </button>
                <button type="button" onClick={() => void saveVersion()} className="icon-tile" aria-label="Save snapshot" title="Save snapshot">
                  <Save size={14} />
                </button>
                <button type="button" onClick={() => void exportZip()} className="icon-tile" aria-label="Export ZIP" title="Export ZIP">
                  <Download size={14} />
                </button>
                <label className="icon-tile cursor-pointer" title="Import ZIP">
                  <Upload size={14} />
                  <input type="file" accept=".zip" className="sr-only" onChange={(e) => void importZip(e.target.files?.[0])} />
                </label>
              </div>
              <FileTree paths={files.map((f) => f.path)} activePath={active?.path ?? ""} onOpen={openFile} />
              {fileOps.length ? (
                <div className="border-t border-border px-3 py-2">
                  <p className="eyebrow text-ink-3">Files</p>
                  <ul className="mt-1 grid gap-0.5">
                    {fileOps.slice(-6).map((op, index) => (
                      <li key={index} className="truncate text-[11px] text-ink-2">
                        <span className="text-success">✓</span> {op.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="flex min-h-0 flex-col">
              {/* §10 file tabs */}
              <div className="flex min-h-11 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-surface-2/40 px-2 py-1.5">
                {openTabs.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => setActivePath(path)}
                    className={cn(
                      "group inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11.5px]",
                      path === active?.path ? "border-accent/40 bg-accent-soft text-ink" : "border-border text-ink-2 hover:text-ink",
                    )}
                  >
                    <span className="max-w-[160px] truncate font-mono">{path.split("/").pop()}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Close ${path}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenTabs((current) => current.filter((item) => item !== path));
                      }}
                      className="text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X size={11} />
                    </span>
                  </button>
                ))}
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {active && renaming !== active.path ? (
                    <button type="button" onClick={() => setRenaming(active.path)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-surface" title="Rename file">
                      <Pencil size={12} /> Rename
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void copyActive()} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-surface" title="Copy file">
                    <Copy size={12} /> Copy
                  </button>
                  <button type="button" onClick={() => active && void removeFile(active.path)} disabled={!active} className="grid h-8 w-8 place-items-center rounded-md text-ink-3 hover:text-danger" aria-label="Delete file">
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>

              {renaming && active ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-2">
                  <Input defaultValue={active.path} className="min-w-0 flex-1 font-mono text-[12px]" onKeyDown={(event) => {
                    if (event.key === "Enter") void renameFile(active.path, (event.target as HTMLInputElement).value.trim());
                    if (event.key === "Escape") setRenaming(null);
                  }} autoFocus aria-label="New file path" />
                  <Button
                    onClick={(event) => {
                      const input = (event.currentTarget.parentElement as HTMLElement).querySelector("input");
                      void renameFile(active.path, input?.value.trim() ?? "");
                    }}
                  >
                    Rename
                  </Button>
                  <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                </div>
              ) : null}

              {run?.changes.length ? <div className="px-3 pt-3"><ChangeSummary changes={run.changes} /></div> : null}

              {active && active.encoding !== "base64" ? (
                <FileEditor path={active.path} value={active.content} onChange={updateActive} disabled={busy} />
              ) : active ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-ink-3">
                  <p>This file is a binary asset — it is served in the preview, not edited as text.</p>
                  <img src={`/api/projects/${project?.id}/preview/${active.path}`} alt={active.path} className="max-h-48 rounded-lg border border-border object-contain" />
                </div>
              ) : (
                <p className="p-4 text-sm text-ink-3">No file selected.</p>
              )}
            </div>
          </div>
        ) : null}

        {tab === "deploy" ? (
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-3xl space-y-4">
              {run ? <BuildStatusCard run={run} /> : null}
              {project ? (
                <DeploymentPanel
                  projectId={project.id}
                  overview={overview}
                  run={run}
                  busy={busy}
                  onRefresh={() => void load(project.id)}
                  onDeploy={({ publish, allowOverride, environment }) =>
                    void runPipeline({ build: false, publish, allowOverride, environment: environment === "preview" ? "preview" : "production" })
                  }
                  onPreview={() => setTab("preview")}
                  onOpenFiles={() => setTab("files")}
                  onManageUrls={() => setTab("assets")}
                />
              ) : null}
              {project ? (
                <UrlManager
                  projectId={project.id}
                  urls={overview?.urls ?? []}
                  origin={typeof window === "undefined" ? "" : window.location.origin}
                  isLive={Boolean(overview?.is_live)}
                  onChanged={() => void load(project.id)}
                />
              ) : null}
              {project ? <EnvPanel projectId={project.id} env={project.env_public ?? {}} onChanged={() => void load(project.id)} /> : null}
              <div className="rounded-xl border border-border bg-surface p-3.5">
                <p className="eyebrow text-ink-3">Slug used by the primary address</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="my-site" className="min-w-0 flex-1" />
                  <Button variant="outline" onClick={() => void runPipeline({ build: false, publish: true, allowOverride: false })} disabled={busy}>
                    Publish to this address
                  </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-ink-3">
                  MATRIX only claims an address once the host has written the files and reports the deployment live. Publishing is limited to 10 per hour.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {tab === "assets" ? (
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-3xl space-y-4">
              {project ? <AssetLibrary projectId={project.id} onOpenFile={(path) => { openFile(path); setTab("files"); }} /> : null}
              <div className="rounded-xl border border-border bg-surface">
                <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
                  <History size={14} className="text-accent" />
                  <p className="eyebrow flex-1 text-ink-3">Snapshots</p>
                  <button type="button" onClick={() => void saveVersion()} disabled={busy} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-accent hover:bg-surface-2">
                    <Save size={12} /> Save snapshot
                  </button>
                </header>
                {versions.length ? (
                  <ul className="divide-y divide-border">
                    {versions.map((v) => (
                      <li key={v.id} className="flex items-center gap-2 px-3.5 py-2 text-xs">
                        <span className="min-w-0 flex-1 truncate text-ink-2">{v.summary || v.source}</span>
                        <span className="shrink-0 text-ink-3">{v.created_at.slice(0, 16).replace("T", " ")}</span>
                        <button type="button" className="shrink-0 font-medium text-accent" onClick={() => void restore(v.id)}>
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-3.5 py-3 text-xs text-ink-3">No snapshots yet.</p>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {tab === "github" ? (
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-lg">{project ? <GithubConnection files={files.map((file) => ({ path: file.path, content: file.content, language: file.language }))} showPush /> : null}</div>
          </div>
        ) : null}
      </div>

      {popup && run ? (
        <DeploySuccessPopup
          run={run}
          url={popup.url}
          files={popup.files}
          onClose={() => setPopup(null)}
          onViewProject={() => {
            setPopup(null);
            setTab("files");
          }}
          onDeploymentDetails={() => {
            setPopup(null);
            setTab("deploy");
          }}
          onAssets={() => {
            setPopup(null);
            setTab("assets");
          }}
        />
      ) : null}
    </div>
  );
}

/** Internal code → human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const code = err instanceof RpcCallError ? err.code : errorCodeOf(err, fallback);
  const view = mapAdminError(code);
  console.error("[MATRIX]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
