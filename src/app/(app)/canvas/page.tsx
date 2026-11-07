import { redirect } from "next/navigation";
import { getCurrentUser, db } from "@/lib/data";
import { listProjects } from "@/lib/server/projects";
import { CanvasClient } from "@/components/canvas-client";

export const metadata = { title: "Canvas" };

export default async function CanvasPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  if (project) redirect(`/projects/${encodeURIComponent(project)}`);
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <CanvasClient projects={await listProjects(db(), user)} />;
}
