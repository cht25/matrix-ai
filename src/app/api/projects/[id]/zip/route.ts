import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { applyProjectFiles, loadProjectFiles } from "@/lib/server/projects";
import { createZip, readZip } from "@/lib/projects/zip";
import { isImagePath } from "@/lib/projects/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await ctx.params;
  const project = await adminDb().collection("projects").doc(id).get();
  if (!project.exists || project.data()?.owner_id !== user.uid) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const files = await loadProjectFiles(adminDb(), id);
  const zip = createZip(files.map((file) => ({
    path: file.path,
    content: file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8"),
  })));
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${(project.data()?.title || "project").replace(/[^\w.-]+/g, "-")}.zip"`,
    },
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await ctx.params;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "FILE_REQUIRED" }, { status: 400 });
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const entries = readZip(buf);
    await applyProjectFiles(adminDb(), user, {
      project_id: id,
      source: "import",
      files: entries.map((entry) => ({
        path: entry.path,
        content: isImagePath(entry.path) ? entry.content.toString("base64") : entry.content.toString("utf8"),
        language: "text",
        encoding: isImagePath(entry.path) ? "base64" : "utf8",
      })),
    });
    return NextResponse.json({ ok: true, count: entries.length });
  } catch (err) {
    const code = err instanceof Error ? err.message : "ZIP_INVALID";
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
