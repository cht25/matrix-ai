// Dedicated print view: the certificate and nothing else.
//
// This route lives OUTSIDE the (app) group, so it renders without the sidebar,
// bottom navigation, chat UI or any other application chrome. The print
// stylesheet in styles/certificate.css then removes even the on-screen helper
// bar, leaving a clean A4 landscape document.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/data";
import { isConfigured } from "@/lib/env";
import { lookupCertificate, isCertificateIdShape } from "@/lib/server/certificates";
import { CertificateDocument } from "@/components/certificate/certificate-document";
import { PrintTrigger } from "@/components/certificate/print-trigger";
import { ServerProblemScreen } from "@/components/server-problem";

export const metadata: Metadata = { title: "Certificate", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function CertificatePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isCertificateIdShape(id)) notFound();
  if (!isConfigured()) return <ServerProblemScreen kind="config" />;

  const cert = await lookupCertificate(db(), id).catch(() => null);
  if (!cert || !cert.valid) notFound();

  return (
    <div className="print-root mx-auto max-w-5xl px-3 py-6">
      <PrintTrigger id={cert.certificate_id} pdfHref={`/api/certificate/${encodeURIComponent(cert.certificate_id)}/pdf`} />
      <CertificateDocument cert={cert} />
    </div>
  );
}
