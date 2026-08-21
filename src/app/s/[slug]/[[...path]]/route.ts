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
  // session. Scripts and inline styles still run for the static preview.
  const sandbox = /^text\/html/i.test(type)
    ? "; sandbox allow-scripts allow-forms allow-modals"
    : "";
  return {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=60",
    "Content-Security-Policy": `default-src 'self' 'unsafe-inline' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'${sandbox}`,
    "X-Frame-Options": "SAMEORIGIN",
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string; path?: string[] }> }) {
  const { slug, path = [] } = await ctx.params;
  const wanted = path.join("/") || "index.html";
  try {
    const file = await loadPublishedFile(adminDb(), slug, wanted);
    if (!file) return new NextResponse("Page not found", { status: 404, headers: headersFor("text/plain; charset=utf-8") });
    if (file.encoding === "base64") {
      return new NextResponse(Buffer.from(file.content, "base64"), { headers: headersFor(file.content_type || contentTypeForPath(file.path)) });
    }
    return new NextResponse(file.content, { headers: headersFor(file.content_type || contentTypeForPath(file.path)) });
  } catch {
    return new NextResponse("Unavailable", { status: 503, headers: headersFor("text/plain; charset=utf-8") });
  }
}
