// DEV-ONLY certificate PDF, rendered from sample data.
//
// Mirrors /api/certificate/[id]/pdf exactly — same engine, same document — but
// needs no Firebase credentials, so the Claim → Preview → Download → Print flow
// can be exercised end to end locally. Returns 404 in production.

import { NextResponse } from "next/server";
import { certificateFilename, renderCertificatePdf } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLE = {
  certificate_id: "MTRX-CERT-2026-000123",
  display_name: "John Doe",
  course: "Python Fundamentals",
  score_percent: 100,
  issued_at: "2026-09-05T10:00:00.000Z",
  issued_by: "MATRIX — THAMJJ13.TOP White Hat Team",
};

export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // Optional overrides so non-Latin rendering can be checked in the browser.
  const url = new URL(req.url);
  const cert = {
    ...SAMPLE,
    display_name: url.searchParams.get("name")?.slice(0, 120) || SAMPLE.display_name,
    course: url.searchParams.get("course")?.slice(0, 160) || SAMPLE.course,
  };

  const bytes = await renderCertificatePdf(cert);
  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${certificateFilename(cert)}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
