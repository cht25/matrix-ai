import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { loadProjectFiles } from "@/lib/server/projects";
import { contentTypeForPath } from "@/lib/projects/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function headersFor(type: string) {
  // CSP `sandbox` on HTML forces an opaque origin: live-preview pages cannot
  // trigger credentialed /api calls on behalf of whoever is viewing them
  // outside the sandboxed iframe (e.g. a direct visit to the preview URL).
  const sandbox = /^text\/html/i.test(type)
    ? "; sandbox allow-scripts allow-forms allow-modals"
    : "";
  return {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": `default-src 'self' 'unsafe-inline' data: blob:; object-src 'none'; base-uri 'none'${sandbox}`,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; path?: string[] }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id, path = [] } = await ctx.params;
  const project = await adminDb().collection("projects").doc(id).get();
  if (!project.exists || project.data()?.owner_id !== user.uid) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const files = await loadProjectFiles(adminDb(), id);
  const wanted = path.join("/") || "index.html";
  const file =
    files.find((f) => f.path === wanted) ??
    files.find((f) => f.path === `${wanted}/index.html`) ??
    files.find((f) => /(^|\/)index\.html?$/i.test(f.path));
  if (!file) return new NextResponse("Not found", { status: 404, headers: headersFor("text/plain") });
  if (file.encoding === "base64") {
    return new NextResponse(Buffer.from(file.content, "base64"), { headers: headersFor(contentTypeForPath(file.path)) });
  }
  return new NextResponse(file.content, { headers: headersFor(contentTypeForPath(file.path)) });
}
