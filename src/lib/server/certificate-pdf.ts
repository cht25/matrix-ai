// =============================================================================
// MATRIX certificate PDF.
//
// This module is now a thin adapter over the ONE shared PDF engine
// (`lib/pdf/engine` via `lib/pdf/documents`). It used to contain a bespoke
// PDF 1.4 writer that drew text with the standard 14 Type 1 fonts and
// WinAnsiEncoding — which cannot represent Bangla or most symbols, so those
// characters were transliterated or stripped and the page came out wrong.
//
// The engine embeds real Unicode TrueType subsets and shapes the text, so
// certificates now render any learner name correctly. Output is still ONLY the
// certificate: one A4 landscape page, no application chrome.
// =============================================================================

import "server-only";
import { renderCertificatePdf as renderCertificate, certificateFilename as filenameFor } from "@/lib/pdf/documents";
import type { PublicCertificate } from "@/lib/server/certificates";

/** Render a certificate as a complete, single-page A4 landscape PDF. */
export function renderCertificatePdf(cert: PublicCertificate): Promise<Uint8Array> {
  return renderCertificate({
    certificate_id: cert.certificate_id,
    course: cert.course,
    display_name: cert.display_name,
    score_percent: cert.score_percent,
    issued_at: cert.issued_at,
    issued_by: cert.issued_by,
  });
}

/** Safe download filename for a certificate. */
export function certificateFilename(cert: PublicCertificate): string {
  return filenameFor(cert);
}
