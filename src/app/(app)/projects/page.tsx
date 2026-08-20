import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { listProjects } from "@/lib/server/projects";
import { EmptyState } from "@/components/ui";
import { FolderKanban } from "lucide-react";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const projects = await listProjects(db(), user);

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow flourish mb-1.5">Workspace</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Projects</h1>
        <p className="mt-1 text-sm text-ink-2">Agent-built sites, saved files, live previews and published URLs.</p>
      </div>
      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban size={22} />}
          title="No projects yet"
          body="Open Agent mode, ask MATRIX to build a site, then apply the files. They will appear here."
          action={<Link href="/chat?mode=agent" className="mt-2 inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-medium text-bg">Start Agent</Link>}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="card card-hover flex min-h-28 flex-col justify-between !p-4">
                <span>
                  <span className="block font-semibold text-ink">{p.title}</span>
                  <span className="mt-1 block text-xs text-ink-3">{p.file_count} files · {p.stack}</span>
                </span>
                <span className="text-[11px] text-ink-3">{p.live_url ? `Live · ${p.live_slug}` : "Not published"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
