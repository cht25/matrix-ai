"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download, FolderPlus, Globe, History, MonitorPlay, Plus, RefreshCcw, Save, Trash2, Upload,
} from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { rpc, RpcCallError } from "@/lib/client/api";
import { buildPreviewHtml } from "@/lib/projects/preview";
import { looksLikeFrameworkProject, type ProjectFile } from "@/lib/projects/paths";
import { GithubConnection } from "@/components/github-connection";
import { FileTree } from "@/components/projects/file-tree";
import { FileEditor } from "@/components/projects/file-editor";
import { Alert, Button, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

type Tab = "preview" | "files" | "publish" | "github";

type ProjectMeta = {
  id: string;
  title: string;
  live_slug: string | null;
  live_url: string | null;
  env_public: Record<string, string>;
  custom_domain: string;
  custom_domain_status: string;
};

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
  const [tab, setTab] = useState<Tab>("preview");
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>(initialFiles.map((f) => ({ ...f, encoding: "utf8" as const })));
  const [activePath, setActivePath] = useState(initialFiles[0]?.path ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [domain, setDomain] = useState("");
  const [versions, setVersions] = useState<{ id: string; summary: string; created_at: string; source: string }[]>([]);
  const [deploy, setDeploy] = useState<{ live_url: string | null; deployments: { id: string; status: string; public_url: string; log: { step: string; detail: string }[] }[] } | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = files.find((f) => f.path === activePath) ?? files[0];
  const preview = useMemo(() => buildPreviewHtml(files), [files]);
  const framework = looksLikeFrameworkProject(files.map((f) => f.path));

  const load = useCallback(async (id: string) => {
    const data = await rpc<{ project: ProjectMeta; files: ProjectFile[] }>("project_get", { id });
    setProject(data.project);
    setFiles(data.files);
    setActivePath((cur) => data.files.some((f) => f.path === cur) ? cur : (data.files[0]?.path ?? ""));
    setSlug(data.project.live_slug ?? "");
    setDomain(data.project.custom_domain ?? "");
    setPublishedUrl(data.project.live_url ?? null);
    onTitle?.(data.project.title);
    const vers = await rpc<{ id: string; summary: string; created_at: string; source: string }[]>("project_version_list", { project_id: id }).catch(() => []);
    setVersions(vers ?? []);
    const dep = await rpc<{ live_url: string | null; deployments: { id: string; status: string; public_url: string; log: { step: string; detail: string }[] }[] }>("project_deployment", { project_id: id }).catch(() => null);
    setDeploy(dep);
  }, [onTitle]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let id = projectId ?? "";
        let applyInitial = !projectId && initialFiles.length > 0;
        if (!projectId) {
          // Reuse the conversation's project when one exists (server-side
          // persistence already linked it), otherwise create it.
          const proj = await rpc<{ id: string; file_count?: number }>("project_ensure", { conversation_id: conversationId ?? null, title: "Agent project" });
          id = proj.id;
          // Only write the generated files when the project is still empty —
          // never clobber files the user has edited since.
          applyInitial = applyInitial && (proj.file_count ?? 0) === 0;
        }
        if (cancelled) return;
        if (applyInitial) {
          await rpc("project_apply_files", { project_id: id, files: initialFiles, source: "agent" }).catch(() => {});
        }
        await load(id);
      } catch (err) {
        if (!cancelled) setMsg(err instanceof RpcCallError ? err.code : "Could not open project.");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, conversationId]);

  function queueSave(nextFiles: ProjectFile[], path: string, content: string) {
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!project) return;
      void rpc("project_file_upsert", { project_id: project.id, path, content }).then(() => {
        setDirty(false);
        setPreviewKey((k) => k + 1);
      }).catch(() => setMsg("Autosave failed."));
    }, 450);
    setFiles(nextFiles);
  }

  function updateActive(content: string) {
    if (!active) return;
    const next = files.map((f) => (f.path === active.path ? { ...f, content } : f));
    queueSave(next, active.path, content);
  }

  async function addFile() {
    if (!project) return;
    const path = prompt("New file path", "pages/about.html");
    if (!path) return;
    setBusy(true);
    try {
      await rpc("project_file_upsert", { project_id: project.id, path, content: "" });
      await load(project.id);
      setActivePath(path);
    } catch (err) {
      setMsg(err instanceof RpcCallError ? err.code : "Could not create file.");
    } finally {
      setBusy(false);
    }
  }

  async function removeFile() {
    if (!project || !active) return;
    if (!confirm(`Delete ${active.path}?`)) return;
    setBusy(true);
    try {
      await rpc("project_file_delete", { project_id: project.id, path: active.path });
      await load(project.id);
    } catch (err) {
      setMsg(err instanceof RpcCallError ? err.code : "Could not delete file.");
    } finally {
      setBusy(false);
    }
  }

  async function saveVersion() {
    if (!project) return;
    setBusy(true);
    try {
      await rpc("project_version_save", { project_id: project.id, source: "manual", summary: "Manual snapshot" });
      await load(project.id);
      setMsg("Version saved.");
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    if (!project) return;
    if (!confirm("Restore this version? A snapshot of the current files is saved first.")) return;
    setBusy(true);
    try {
      await rpc("project_version_restore", { project_id: project.id, version_id: id });
      await load(project.id);
    } finally {
      setBusy(false);
    }
  }

  const PUBLISH_ERRORS: Record<string, string> = {
    NO_FILES: "Add at least one file before publishing.",
    INDEX_REQUIRED: "The site needs an index.html file as its entry page.",
    SLUG_TAKEN: "That public address is already taken. Choose a different slug.",
    SLUG_INVALID: "The slug can only use lowercase letters, numbers and dashes.",
    PUBLISH_RATE_LIMITED: "Too many publishes in the last hour — wait a moment and try again.",
    PROJECT_LIMIT: "You have reached the project limit for your account.",
  };

  async function publish() {
    if (!project) return;
    const hasHtml = files.some((f) => /\.html?$/i.test(f.path) && f.encoding !== "base64");
    if (!hasHtml) {
      setMsg("INDEX_REQUIRED: Your project needs an index.html entry page before it can go public.");
      return;
    }
    setPublishing(true);
    setBusy(true);
    setMsg(null);
    try {
      const result = await rpc<{ public_url: string; slug: string; status: string }>("project_publish", { project_id: project.id, slug });
      setPublishedUrl(result.public_url);
      await load(project.id);
      setTab("publish");
      setMsg(`PUBLISHED:${result.public_url}`);
    } catch (err) {
      const code = err instanceof RpcCallError ? err.code : "Publish failed.";
      setMsg(PUBLISH_ERRORS[code] ?? `Publish failed (${code}). Check the model created a complete index.html and try again.`);
    } finally {
      setPublishing(false);
      setBusy(false);
    }
  }

  async function unpublish() {
    if (!project) return;
    setBusy(true);
    try {
      await rpc("project_unpublish", { project_id: project.id });
      setPublishedUrl(null);
      await load(project.id);
      setMsg("Site unpublished.");
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
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "IMPORT_FAILED");
      }
      await load(project.id);
      setMsg("ZIP imported.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function addDomain() {
    if (!project || !domain.trim()) return;
    setBusy(true);
    try {
      const result = await rpc<{ instructions: string; status: string }>("project_add_domain", { project_id: project.id, domain });
      setMsg(`${result.status}: ${result.instructions}`);
    } catch (err) {
      setMsg(err instanceof RpcCallError ? err.code : "Domain could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const previewSrc = project ? `/api/projects/${project.id}/preview/` : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-2">
        {([
          { id: "preview" as const, label: "Live preview", icon: <MonitorPlay size={14} /> },
          { id: "files" as const, label: "Files", icon: <FolderPlus size={14} /> },
          { id: "publish" as const, label: "Publish", icon: <Globe size={14} /> },
          { id: "github" as const, label: "GitHub", icon: <History size={14} /> },
        ]).map((item) => (
          <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium", tab === item.id ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink")}>
            {item.icon}{item.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-ink-3">{dirty ? "Saving…" : project ? `${files.length} files` : ""}</span>
      </div>
      {msg ? (
        <div className="px-3 pt-2">
          {msg.startsWith("PUBLISHED:") ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2.5 text-sm">
              <Globe size={15} className="shrink-0 text-success" />
              <span className="font-medium text-ink">Your site is live and public — all CSS and JavaScript are baked into the page.</span>
              <a href={msg.slice("PUBLISHED:".length)} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover">
                Open live site
              </a>
            </div>
          ) : (
            <Alert tone={msg.includes("failed") || msg.includes("INDEX_REQUIRED") ? "warning" : "info"}>{msg}</Alert>
          )}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "preview" ? (
          <div className="flex h-full flex-col">
            <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-2/60 px-3">
              <p className="text-xs text-ink-3">{framework ? "Framework files detected — static preview uses index.html only." : preview.message}</p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const html = files.find((f) => /\.html?$/i.test(f.path))?.content ?? files[0]?.content ?? "";
                    void navigator.clipboard.writeText(html).then(() => setMsg("Copied.")).catch(() => {});
                  }}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-surface"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => void publish()}
                  disabled={publishing || busy || !project}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                >
                  {publishing ? <Spinner /> : <Globe size={12} />} {publishing ? "Publishing…" : publishedUrl ? "Update live site" : "Make public"}
                </button>
                {publishedUrl ? (
                  <a href={publishedUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-accent hover:bg-surface">
                    View live
                  </a>
                ) : null}
                <button type="button" onClick={() => setPreviewKey((k) => k + 1)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-surface"><RefreshCcw size={12} /> Refresh</button>
              </div>
            </div>
            {project ? (
              <iframe key={previewKey} title="Project live preview" sandbox="allow-scripts allow-forms allow-modals" src={`${previewSrc}?v=${previewKey}`} className="h-full w-full border-0 bg-white" />
            ) : (
              <div className="grid flex-1 place-items-center text-sm text-ink-3"><Spinner /> Opening project…</div>
            )}
          </div>
        ) : null}

        {tab === "files" ? (
          <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(150px,220px)_1fr]">
            <div className="min-h-0 overflow-y-auto border-b border-border bg-surface-2/45 md:border-b-0 md:border-r">
              <div className="flex gap-1 p-2">
                <button type="button" onClick={() => void addFile()} className="grid h-9 w-9 place-items-center rounded-md hover:bg-surface" aria-label="New file"><Plus size={14} /></button>
                <button type="button" onClick={() => void saveVersion()} className="grid h-9 w-9 place-items-center rounded-md hover:bg-surface" aria-label="Save version"><Save size={14} /></button>
                <button type="button" onClick={() => void exportZip()} className="grid h-9 w-9 place-items-center rounded-md hover:bg-surface" aria-label="Export ZIP"><Download size={14} /></button>
                <label className="grid h-9 w-9 cursor-pointer place-items-center rounded-md hover:bg-surface" aria-label="Import ZIP">
                  <Upload size={14} />
                  <input type="file" accept=".zip" className="sr-only" onChange={(e) => void importZip(e.target.files?.[0])} />
                </label>
              </div>
              <FileTree paths={files.map((f) => f.path)} activePath={active?.path ?? ""} onOpen={setActivePath} />
            </div>
            <div className="flex min-h-0 flex-col">
              <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3">
                <p className="truncate font-mono text-[11px] text-ink-2">{active?.path ?? "No file"}</p>
                <button type="button" onClick={() => void removeFile()} disabled={!active} className="grid h-8 w-8 place-items-center rounded-md text-ink-3 hover:text-danger" aria-label="Delete file"><Trash2 size={13} /></button>
              </div>
              {active && active.encoding !== "base64" ? (
                <FileEditor path={active.path} value={active.content} onChange={updateActive} disabled={busy} />
              ) : (
                <p className="p-4 text-sm text-ink-3">This file is a binary asset and is previewed, not edited as text.</p>
              )}
            </div>
          </div>
        ) : null}

        {tab === "publish" ? (
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-lg space-y-4">
              <div>
                <p className="eyebrow">First-party hosting</p>
                <h2 className="mt-1 font-display text-2xl font-semibold text-ink">Make this site public</h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">
                  MATRIX bundles your project into a single, ready-to-open public page — all local CSS, JavaScript and
                  images are inlined into the HTML, so the live site renders completely with nothing else to upload.
                  This is a real publish at a shareable public URL, not a simulation.
                </p>
              </div>
              {publishedUrl ? (
                <div className="rounded-lg border border-success/40 bg-success/10 p-3">
                  <p className="text-sm font-semibold text-ink">Currently public</p>
                  <p className="mt-1 break-all font-mono text-xs text-ink-2">{publishedUrl}</p>
                </div>
              ) : null}
              <label className="block text-xs font-medium text-ink-2">Public address (slug)
                <Input className="mt-1" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-site" />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void publish()} disabled={publishing || busy}>
                  {publishing ? <><Spinner /> Publishing…</> : <><Globe size={15} /> {publishedUrl ? "Publish update" : "Make public"}</>}
                </Button>
                <Button variant="outline" onClick={() => void unpublish()} disabled={busy || !publishedUrl}>Unpublish</Button>
                {publishedUrl ? <a href={publishedUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-accent">Open live site</a> : null}
              </div>
              <p className="text-xs leading-relaxed text-ink-3">
                Publishing is limited to 10 times per hour. The public page runs in a sandboxed iframe with scripts
                enabled — forms, interactions and animations work exactly as in the live preview.
              </p>
              {deploy?.deployments?.[0] ? (
                <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs text-ink-2">
                  <p className="font-semibold text-ink">Latest: {deploy.deployments[0].status}</p>
                  <ul className="mt-2 space-y-1">
                    {(deploy.deployments[0].log ?? []).map((line, i) => <li key={i}>{line.step} — {line.detail}</li>)}
                  </ul>
                </div>
              ) : null}
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-sm font-semibold text-ink">Custom domain</p>
                <p className="text-xs text-ink-3">Status stays pending_dns until the challenge file is reachable. We will not mark it connected unless verification succeeds.</p>
                <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.example.com" />
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => void addDomain()} disabled={busy}>Save domain</Button>
                  <Button variant="ghost" onClick={() => project && rpc("project_verify_domain", { project_id: project.id }).then((r) => setMsg(JSON.stringify(r)))} disabled={busy}>Check DNS</Button>
                </div>
              </div>
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-sm font-semibold text-ink">Versions</p>
                {versions.length ? versions.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
                    <span>{v.summary || v.source} · {v.created_at.slice(0, 16).replace("T", " ")}</span>
                    <button type="button" className="font-medium text-accent" onClick={() => void restore(v.id)}>Restore</button>
                  </div>
                )) : <p className="text-xs text-ink-3">No snapshots yet.</p>}
              </div>
            </div>
          </div>
        ) : null}

        {tab === "github" ? (
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-lg">
              <GithubConnection files={files} showPush />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
