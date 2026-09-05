// Shared PDF export endpoint.
//
// One engine for every PDF the platform produces: chat export, document
// export, and anything added later. It renders server-side because real
// Unicode output requires embedded TrueType subsets plus OpenType shaping,
// which cannot be done with the standard 14 PDF fonts the old client-side
// writer used.

import { NextResponse } from "next/server";
import { renderDocumentPdf } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONTENT = 400_000;

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const body = (payload ?? {}) as { content?: unknown; title?: unknown; subtitle?: unknown; footer?: unknown };
  const content = typeof body.content === "string" ? body.content : "";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "MATRIX document";

  if (!content.trim()) {
    return NextResponse.json({ error: "CONTENT_REQUIRED" }, { status: 400 });
  }
  if (content.length > MAX_CONTENT) {
    return NextResponse.json({ error: "CONTENT_TOO_LARGE" }, { status: 413 });
  }

  try {
    const bytes = await renderDocumentPdf(content, {
      title,
      subtitle: typeof body.subtitle === "string" ? body.subtitle.slice(0, 300) : null,
      footer: typeof body.footer === "string" ? body.footer.slice(0, 120) : "MATRIX",
    });
    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[MATRIX] PDF export failed", error);
    return NextResponse.json({ error: "PDF_EXPORT_FAILED" }, { status: 500 });
  }
}
