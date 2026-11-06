"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { rpc } from "@/lib/client/api";
import { ProjectWorkspace } from "@/components/projects/project-workspace";
import { Button, Alert } from "@/components/ui";

type Project = { id: string; title: string };

/** Canvas code surface reuses the canonical project store, versions and sandbox. */
export function CanvasClient({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const project = await rpc<{ id: string }>("project_ensure", { title: "Canvas document" });
      await rpc("project_apply_files", { project_id: project.id, source: "manual", files: [
        { path: "index.html", content: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas document</title><style>body{font-family:system-ui;max-width:800px;margin:48px auto;padding:24px}h1{color:#047857}</style></head><body><h1>Untitled document</h1><p>Edit index.html in Files to begin.</p></body></html>' },
      ] });
      router.push(`/canvas?project=${encodeURIComponent(project.id)}`);
      router.refresh();
    } catch { setError("Could not create the canvas document. Check your connection and try again."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Canvas</h1><p className="text-sm text-ink-2">Code and document canvas · database-backed files, sandboxed preview, versions and export.</p></div>
      <Button disabled={busy} onClick={() => void create()}>{busy ? "Creating…" : "New document"}</Button>
    </header>
    {error && <Alert tone="danger">{error}</Alert>}
    <div className="flex flex-wrap gap-2" aria-label="Saved canvas projects">
      {projects.map((project) => <Link key={project.id} className="btn-secondary" aria-current={projectId === project.id ? "page" : undefined} href={`/canvas?project=${encodeURIComponent(project.id)}`}>{project.title}</Link>)}
    </div>
    {projectId ? <ProjectWorkspace key={projectId} projectId={projectId} /> : <p className="text-ink-2">Create a document or open an existing workspace project. Visual drag-and-drop and diagram editing are not supported yet.</p>}
    <Link href="/chat?mode=agent" className="text-accent">Open AI Agent to generate or revise project files →</Link>
  </div>;
}
