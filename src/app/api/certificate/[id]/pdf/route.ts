// Certificate PDF download — returns ONLY the certificate document, never a
// screenshot of the application. Public by ID (same data as the public
// verification page); no personal data beyond the display name is included.

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { isServerConfigured } from "@/lib/env";
import { lookupCertificate, isCertificateIdShape } from "@/lib/server/certificates";
import { certificateFilename, renderCertificatePdf } from "@/lib/server/certificate-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCertificateIdShape(id)) {
    return NextResponse.json({ error: "CERTIFICATE_ID_INVALID" }, { status: 400 });
  }
  if (!isServerConfigured()) {
    return NextResponse.json({ error: "SERVER_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const cert = await lookupCertificate(adminDb(), id);
    if (!cert.valid) {
      return NextResponse.json({ error: "CERTIFICATE_NOT_FOUND" }, { status: 404 });
    }
    const bytes = await renderCertificatePdf(cert);
    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${certificateFilename(cert)}"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("[MATRIX] certificate PDF failed", error);
    return NextResponse.json({ error: "CERTIFICATE_PDF_FAILED" }, { status: 500 });
  }
}
