import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getProject } from "@/lib/server/projects";
import { RpcError } from "@/lib/server/errors";
import { ProjectWorkspace } from "@/components/projects/project-workspace";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  try {
    await getProject(db(), user, id);
  } catch (err) {
    if (err instanceof RpcError && err.status === 404) notFound();
    throw err;
  }
  return (
    <div className="flex min-h-[70dvh] flex-col overflow-hidden rounded-xl border border-border bg-bg">
      <ProjectWorkspace projectId={id} />
    </div>
  );
}
