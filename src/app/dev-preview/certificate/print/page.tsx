// DEV-ONLY print view for the certificate, with sample data.
//
// Identical in structure to /certificate/print/[id]: it lives OUTSIDE the (app)
// route group, so there is no sidebar, bottom navigation or chat UI on the
// page — and therefore none of it on paper. Returns 404 in production.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CertificateDocument } from "@/components/certificate/certificate-document";
import { PrintTrigger } from "@/components/certificate/print-trigger";

export const metadata: Metadata = { title: "Certificate", robots: { index: false } };
export const dynamic = "force-dynamic";

const SAMPLE = {
  certificate_id: "MTRX-CERT-2026-000123",
  display_name: "John Doe",
  course: "Python Fundamentals",
  score_percent: 100,
  issued_at: "2026-09-05T10:00:00.000Z",
  issued_by: "MATRIX — THAMJJ13.TOP White Hat Team",
};

export default function DevPreviewCertificatePrintPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="print-root mx-auto max-w-5xl px-3 py-6">
      <PrintTrigger id={SAMPLE.certificate_id} pdfHref="/api/dev-preview/certificate/pdf" />
      <CertificateDocument cert={SAMPLE} />
    </div>
  );
}
