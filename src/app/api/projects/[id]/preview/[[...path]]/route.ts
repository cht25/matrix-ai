import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { loadProjectFiles } from "@/lib/server/projects";
import { contentTypeForPath } from "@/lib/projects/paths";
import { buildPreviewHtml } from "@/lib/projects/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function headersFor(type: string) {
  // CSP `sandbox` on HTML forces an opaque origin: live-preview pages cannot
  // trigger credentialed /api calls on behalf of whoever is viewing them
  // outside the sandboxed iframe (e.g. a direct visit to the preview URL).
  const sandbox = /^text\/html/i.test(type)
    ? "; sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads"
    : "";
  return {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data: blob:; media-src * data: blob:; connect-src * data: blob:; object-src 'none'${sandbox}`,
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
  const rawPath = path.join("/");
  const wanted = rawPath || "index.html";

  // Root / main document preview: use buildPreviewHtml for instant inlined rendering
  if (!rawPath || rawPath === "index.html") {
    const preview = buildPreviewHtml(files);
    if (preview.available && preview.html) {
      let html = preview.html;
      if (!/<base\b/i.test(html)) {
        if (/<head\b[^>]*>/i.test(html)) {
          html = html.replace(/(<head\b[^>]*>)/i, `$1\n<base href="/api/projects/${id}/preview/">`);
        } else if (/<html\b[^>]*>/i.test(html)) {
          html = html.replace(/(<html\b[^>]*>)/i, `$1\n<head><base href="/api/projects/${id}/preview/"></head>`);
        } else {
          html = `<base href="/api/projects/${id}/preview/">\n${html}`;
        }
      }
      return new NextResponse(html, { headers: headersFor("text/html; charset=utf-8") });
    }
  }

  // Exact or normalized match for subresources
  const normalizedWanted = wanted.replace(/^\.?\/+/, "").toLowerCase();
  const baseName = wanted.split("/").pop()?.toLowerCase() ?? "";

  const file =
    files.find((f) => f.path === wanted) ??
    files.find((f) => (f.path || "").replace(/^\.?\/+/, "").toLowerCase() === normalizedWanted) ??
    files.find((f) => {
      const p = (f.path || "").replace(/^\.?\/+/, "").toLowerCase();
      return p === `${normalizedWanted}.html` || p === `${normalizedWanted}/index.html`;
    }) ??
    files.find((f) => (f.path || "").split("/").pop()?.toLowerCase() === baseName);

  if (!file) return new NextResponse("Not found", { status: 404, headers: headersFor("text/plain; charset=utf-8") });
  if (file.encoding === "base64") {
    return new NextResponse(Buffer.from(file.content, "base64"), { headers: headersFor(contentTypeForPath(file.path)) });
  }
  return new NextResponse(file.content, { headers: headersFor(contentTypeForPath(file.path)) });
}
