"use client";

// Certificate preview + print + PDF download.
//
// Print opens the dedicated /certificate/print/[id] view in a new window and
// prints THAT document, so the printed page can never contain the application
// shell, chat UI or navigation. The PDF comes from the server-rendered
// /api/certificate/[id]/pdf endpoint — again, certificate only.

import { useState } from "react";
import { Download, ExternalLink, Printer } from "lucide-react";
import { CertificateDocument, type CertificateData } from "@/components/certificate/certificate-document";
import { Alert, Button } from "@/components/ui";

export function CertificateActions({ cert }: { cert: CertificateData }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const printUrl = `/certificate/print/${encodeURIComponent(cert.certificate_id)}`;
  const pdfUrl = `/api/certificate/${encodeURIComponent(cert.certificate_id)}/pdf`;

  function print() {
    setError(null);
    const win = window.open(printUrl, "_blank", "noopener,width=1100,height=800");
    if (!win) {
      setError("Your browser blocked the print window. Allow pop-ups for MATRIX, or open the certificate and use your browser's Print command.");
    }
  }

  async function download() {
    setError(null);
    setDownloading(true);
    try {
      const res = await fetch(pdfUrl, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `MATRIX-${cert.certificate_id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[MATRIX] certificate PDF download failed", err);
      setError("The certificate PDF could not be downloaded. Please try again in a moment.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
          Preview certificate
        </Button>
        <Button variant="secondary" onClick={print}>
          <Printer size={15} strokeWidth={1.8} aria-hidden="true" /> Print
        </Button>
        <Button onClick={() => void download()} disabled={downloading} aria-busy={downloading}>
          <Download size={15} strokeWidth={1.8} aria-hidden="true" />
          {downloading ? "Preparing PDF…" : "Download PDF"}
        </Button>
        <a
          href={`/certificate/verify/${encodeURIComponent(cert.certificate_id)}`}
          className="btn btn-ghost"
        >
          <ExternalLink size={15} strokeWidth={1.8} aria-hidden="true" /> Verification page
        </a>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {previewOpen ? (
        <div
          className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-[rgba(2,6,14,0.7)] p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Certificate preview"
          onClick={() => setPreviewOpen(false)}
        >
          <div className="modal-pop w-full max-w-4xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <CertificateDocument cert={cert} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setPreviewOpen(false)}>Close</Button>
              <Button variant="secondary" onClick={print}>
                <Printer size={15} strokeWidth={1.8} aria-hidden="true" /> Print
              </Button>
              <Button onClick={() => void download()} disabled={downloading} aria-busy={downloading}>
                <Download size={15} strokeWidth={1.8} aria-hidden="true" />
                {downloading ? "Preparing PDF…" : "Download PDF"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
