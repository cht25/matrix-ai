import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { loadPublishedFile } from "@/lib/server/deploy";
import { contentTypeForPath } from "@/lib/projects/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function headersFor(type: string) {
  // User-generated HTML must NEVER be able to make credentialed same-origin
  // API calls: the CSP `sandbox` directive forces an opaque origin for the
  // document, so with same-site=lax cookies its fetch() to /api/* carries no
  // session. Scripts, inline styles and external CDNs still run for the published site.
  const sandbox = /^text\/html/i.test(type)
    ? "; sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads"
    : "";
  return {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=60",
    "Content-Security-Policy": `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data: blob:; media-src * data: blob:; connect-src * data: blob:; object-src 'none'; base-uri 'self' ; form-action *${sandbox}`,
    "X-Frame-Options": "SAMEORIGIN",
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string; path?: string[] }> }) {
  const { slug, path = [] } = await ctx.params;

  // Canonicalize trailing slash for root site URL: /s/my-slug -> /s/my-slug/
  if (path.length === 0 && !req.nextUrl.pathname.endsWith("/")) {
    // Never build Location from req.nextUrl: behind a proxy Next may see the
    // upstream http://localhost:10000 rather than the visitor's HTTPS host.
    // A relative Location is resolved by the browser on its current origin.
    return new NextResponse(null, { status: 308, headers: { Location: `/s/${encodeURIComponent(slug)}/${req.nextUrl.search}`, "Cache-Control": "no-store" } });
  }

  const wanted = path.join("/") || "index.html";
  try {
    const releaseId = req.nextUrl.searchParams.get("__matrix_verify");
    const token = req.headers.get("x-matrix-verification-token");
    const verification = releaseId && token ? { releaseId, token } : undefined;
    const file = await loadPublishedFile(adminDb(), slug, wanted, verification);
    if (!file) return new NextResponse("Page not found", { status: 404, headers: { ...headersFor("text/plain; charset=utf-8"), ...(releaseId ? { "Cache-Control": "private, no-store" } : {}) } });
    const responseHeaders = headersFor(file.content_type || contentTypeForPath(file.path));
    if (releaseId) responseHeaders["Cache-Control"] = "private, no-store";

    let content = file.content;
    const isHtml = /^text\/html/i.test(file.content_type || contentTypeForPath(file.path));

    if (isHtml && file.encoding !== "base64") {
      // Inject <base href="/s/${slug}/"> if no base tag exists, so relative assets (CSS, JS, images) always resolve to /s/${slug}/...
      if (!/<base\b/i.test(content)) {
        if (/<head\b[^>]*>/i.test(content)) {
          content = content.replace(/(<head\b[^>]*>)/i, `$1\n<base href="/s/${slug}/">`);
        } else if (/<html\b[^>]*>/i.test(content)) {
          content = content.replace(/(<html\b[^>]*>)/i, `$1\n<head><base href="/s/${slug}/"></head>`);
        } else {
          content = `<base href="/s/${slug}/">\n${content}`;
        }
      }
      return new NextResponse(content, { headers: responseHeaders });
    }

    if (file.encoding === "base64") {
      return new NextResponse(Buffer.from(file.content, "base64"), { headers: responseHeaders });
    }
    return new NextResponse(file.content, { headers: responseHeaders });
  } catch {
    return new NextResponse("Unavailable", { status: 503, headers: headersFor("text/plain; charset=utf-8") });
  }
}
