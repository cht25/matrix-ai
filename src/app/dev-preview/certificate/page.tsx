// DEV-ONLY visual preview of the certificate document, preview modal, print
// view and PDF actions — rendered with sample data so the layout can be
// reviewed without Firebase credentials. Returns 404 in production and is
// never linked from the application.

import { notFound } from "next/navigation";
import { CertificateDocument } from "@/components/certificate/certificate-document";
import { CertificateActions } from "@/components/certificate/certificate-actions";

export const dynamic = "force-dynamic";

const SAMPLE = {
  certificate_id: "MTRX-CERT-2026-000123",
  display_name: "John Doe",
  course: "Python Fundamentals",
  score_percent: 100,
  issued_at: "2026-09-05T10:00:00.000Z",
  issued_by: "MATRIX — THAMJJ13.TOP White Hat Team",
};

export default function DevPreviewCertificatePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8">
      <div>
        <p className="eyebrow">Dev preview</p>
        <h1 className="mt-1">Certificate document</h1>
      </div>
      <CertificateDocument cert={SAMPLE} />
      <CertificateActions cert={SAMPLE} />
    </div>
  );
}
