"use client";

import { useEffect, useMemo, useState } from "react";
import { Code2, Copy, Download, ExternalLink, FileCode2, Github, MonitorPlay, RefreshCcw, X } from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { GithubConnection } from "@/components/github-connection";
import { cn } from "@/lib/utils";

function normaliseRef(ref: string): string {
  return ref.replace(/^\.\//, "").split(/[?#]/)[0];
}

function buildPreview(files: AgentFile[]): { html: string; available: boolean; message: string } {
  const htmlFile = files.find((file) => /(^|\/)index\.html?$/i.test(file.path)) ?? files.find((file) => /\.html?$/i.test(file.path));
  if (!htmlFile) {
    return {
      html: "",
      available: false,
      message: "A browser preview needs an index.html file. The generated source is still available in Files.",
    };
  }

  const byPath = new Map(files.map((file) => [normaliseRef(file.path), file.content]));
  const base = htmlFile.path.includes("/") ? htmlFile.path.slice(0, htmlFile.path.lastIndexOf("/") + 1) : "";
  const find = (ref: string) => byPath.get(normaliseRef(ref)) ?? byPath.get(normaliseRef(base + ref));

  let html = htmlFile.content;
  html = html.replace(/<link\b([^>]*?)href=["']([^"']+\.css(?:[?#][^"']*)?)["']([^>]*)>/gi, (full, before: string, href: string, after: string) => {
    const css = find(href);
    return css == null ? full : `<style data-matrix-source="${normaliseRef(href)}">${css.replace(/<\/style/gi, "<\\/style")}</style>`;
  });
  html = html.replace(/<script\b([^>]*?)src=["']([^"']+\.(?:js|mjs)(?:[?#][^"']*)?)["']([^>]*)>\s*<\/script>/gi, (full, before: string, src: string) => {
    const js = find(src);
    return js == null ? full : `<script data-matrix-source="${normaliseRef(src)}">${js.replace(/<\/script/gi, "<\\/script")}<\/script>`;
  });
  if (!/<meta\s+name=["']viewport/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, '<head$1><meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  return { html, available: true, message: "Static HTML/CSS/JavaScript preview" };
}

function downloadFile(file: AgentFile) {
  const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = file.path.split("/").pop() || "matrix-file.txt";
  anchor.click();
  URL.revokeObjectURL(href);
}

type Tab = "preview" | "files" | "github";

export function AgentWorkspace({ files, open, onClose }: { files: AgentFile[]; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("preview");
  const [activePath, setActivePath] = useState(files[0]?.path ?? "");
  const [previewKey, setPreviewKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const preview = useMemo(() => buildPreview(files), [files]);
  const activeFile = files.find((file) => file.path === activePath) ?? files[0];

  useEffect(() => {
    if (!files.some((file) => file.path === activePath)) setActivePath(files[0]?.path ?? "");
  }, [files, activePath]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  if (!open) return null;

  async function copy() {
    if (!activeFile) return;
    await navigator.clipboard.writeText(activeFile.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <button type="button" className="fixed inset-0 z-[69] bg-black/45 backdrop-blur-sm" onClick={onClose} aria-label="Close Agent workspace" />
      <aside className="fixed inset-y-0 right-0 z-[70] flex w-full flex-col border-l border-border bg-bg shadow-[var(--shadow-pop)] sm:w-[min(92vw,760px)]" aria-label="Agent workspace">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-white"><Code2 size={16} /></span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">Agent workspace</p>
              <p className="text-[11px] text-ink-3">{files.length} generated file{files.length === 1 ? "" : "s"} · review before push</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Close Agent workspace"><X size={17} /></button>
        </header>

        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
          {([
            { id: "preview" as const, label: "Live preview", icon: <MonitorPlay size={14} /> },
            { id: "files" as const, label: "Files", icon: <FileCode2 size={14} /> },
            { id: "github" as const, label: "GitHub", icon: <Github size={14} /> },
          ]).map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium", tab === item.id ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink")}>
              {item.icon}{item.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "preview" ? (
            <div className="flex h-full flex-col">
              <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-2/60 px-3">
                <div className="flex items-center gap-2 text-xs text-ink-3"><span className={cn("h-1.5 w-1.5 rounded-full", preview.available ? "bg-success" : "bg-warning")} />{preview.message}</div>
                <button type="button" onClick={() => setPreviewKey((value) => value + 1)} disabled={!preview.available} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-surface disabled:opacity-40"><RefreshCcw size={12} /> Refresh</button>
              </div>
              {preview.available ? (
                <iframe key={previewKey} title="Generated project live preview" sandbox="allow-scripts allow-forms allow-modals" srcDoc={preview.html} className="h-full w-full border-0 bg-white" />
              ) : (
                <div className="grid flex-1 place-items-center p-8 text-center">
                  <div className="max-w-sm"><MonitorPlay size={28} className="mx-auto text-ink-3" /><p className="mt-3 text-sm font-semibold text-ink">No static preview yet</p><p className="mt-1 text-xs leading-relaxed text-ink-2">Ask Agent to create an index.html, or review framework files in the Files tab. Framework builds need a connected runtime and are never faked here.</p><button type="button" onClick={() => setTab("files")} className="mt-4 text-xs font-medium text-accent hover:underline">Open generated files</button></div>
                </div>
              )}
            </div>
          ) : null}

          {tab === "files" ? (
            <div className="grid h-full min-h-0 grid-cols-[minmax(130px,190px)_1fr]">
              <nav className="min-h-0 overflow-y-auto border-r border-border bg-surface-2/45 p-2" aria-label="Generated files">
                {files.length ? files.map((file) => (
                  <button key={file.path} type="button" onClick={() => setActivePath(file.path)} className={cn("mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs", activeFile?.path === file.path ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:bg-surface")}><FileCode2 size={13} className="shrink-0 text-ink-3" /><span className="truncate">{file.path}</span></button>
                )) : <p className="p-2 text-xs text-ink-3">No files generated.</p>}
              </nav>
              <div className="flex min-w-0 flex-col">
                <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3">
                  <p className="truncate font-mono text-[11px] text-ink-2">{activeFile?.path ?? "No file"}</p>
                  <div className="flex items-center">
                    <button type="button" onClick={() => void copy()} disabled={!activeFile} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink"><Copy size={12} />{copied ? "Copied" : "Copy"}</button>
                    <button type="button" onClick={() => activeFile && downloadFile(activeFile)} disabled={!activeFile} className="grid h-8 w-8 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Download file"><Download size={12} /></button>
                  </div>
                </div>
                <pre className="min-h-0 flex-1 overflow-auto bg-[#05070f] p-4 text-[12px] leading-relaxed text-[#dbe6ff]"><code>{activeFile?.content ?? ""}</code></pre>
              </div>
            </div>
          ) : null}

          {tab === "github" ? (
            <div className="h-full overflow-y-auto p-4 sm:p-6">
              <div className="mx-auto max-w-lg">
                <div className="mb-5">
                  <p className="eyebrow">Explicit approval only</p>
                  <h2 className="mt-1 font-display text-2xl font-semibold text-ink">Push reviewed changes</h2>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">MATRIX creates one atomic commit on the branch you choose. It never pushes automatically and your GitHub token is not shared with Nemotron or OpenRouter.</p>
                </div>
                <GithubConnection files={files} showPush />
                <a href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/reviewing-your-authorized-oauth-apps" target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink"><ExternalLink size={11} /> Manage authorised apps on GitHub</a>
              </div>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}
