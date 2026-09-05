import { describe, expect, it } from "vitest";
import { formatCertificateId, isCertificateIdShape } from "../src/lib/server/certificates";
import { certificateFilename, renderCertificatePdf } from "../src/lib/server/certificate-pdf";
import { extractPdfText } from "./helpers/pdf-text";
import type { PublicCertificate } from "../src/lib/server/certificates";

const CERT: PublicCertificate = {
  valid: true,
  certificate_id: "MTRX-CERT-2026-000123",
  course: "Python Fundamentals",
  display_name: "John Doe",
  score_percent: 100,
  issued_at: "2026-09-05T10:00:00.000Z",
  issued_by: "MATRIX — THAMJJ13.TOP White Hat Team",
  verification_status: "valid",
};

describe("certificate IDs", () => {
  it("formats a stable, zero-padded, human-readable ID", () => {
    expect(formatCertificateId(2026, 123)).toBe("MTRX-CERT-2026-000123");
    expect(formatCertificateId(2026, 1)).toBe("MTRX-CERT-2026-000001");
    // Never truncates once the sequence outgrows the padding.
    expect(formatCertificateId(2026, 1234567)).toBe("MTRX-CERT-2026-1234567");
  });

  it("recognises current and legacy ID shapes and rejects junk", () => {
    expect(isCertificateIdShape("MTRX-CERT-2026-000123")).toBe(true);
    expect(isCertificateIdShape("MATRIX-2025-AB12CD34")).toBe(true);
    expect(isCertificateIdShape("")).toBe(false);
    expect(isCertificateIdShape("../../etc/passwd")).toBe(false);
    expect(isCertificateIdShape("<script>alert(1)</script>")).toBe(false);
  });
});

describe("certificate PDF", () => {
  // Rendered by the shared MATRIX PDF engine: one A4 landscape page, real
  // embedded Unicode fonts, certificate content only.
  it("produces a structurally valid single-page A4 landscape PDF", async () => {
    const pdf = await renderCertificatePdf(CERT);
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).toContain("%%EOF");
    expect(raw).toContain("/Catalog");
    expect(raw).toContain("/MediaBox [0 0 842 595]");
    // Real embedded font programs, not the Latin-1-only standard 14.
    expect(raw).toContain("/FontFile2");
    expect(raw).toContain("/ToUnicode");
    expect(raw).not.toContain("WinAnsiEncoding");
    // A certificate is a few tens of KB once fonts are subset in.
    expect(pdf.byteLength).toBeGreaterThan(5000);
  });

  it("contains the real certificate data, not placeholders", async () => {
    const text = await extractPdfText(await renderCertificatePdf(CERT));
    expect(text).toContain("John Doe");
    expect(text).toContain("Python Fundamentals");
    expect(text).toContain("MTRX-CERT-2026-000123");
    expect(text).toContain("100%");
    expect(text).toContain("CERTIFICATE OF COMPLETION");
  });

  it("renders a Bangla learner name and course without dropping characters", async () => {
    const text = await extractPdfText(
      await renderCertificatePdf({ ...CERT, display_name: "রাফিদ হাসান", course: "সাইবার নিরাপত্তা মৌলিক" }),
    );
    expect(text).toContain("রাফিদ হাসান");
    expect(text).toContain("সাইবার নিরাপত্তা মৌলিক");
    // The old writer replaced unsupported characters with "?" or nothing.
    expect(text).not.toContain("?");
  });

  it("keeps characters that would corrupt a PDF string", async () => {
    const text = await extractPdfText(await renderCertificatePdf({ ...CERT, display_name: "A (B) \\ C" }));
    expect(text).toContain("A (B) \\ C");
  });

  it("builds a safe download filename", () => {
    expect(certificateFilename(CERT)).toBe("MATRIX-MTRX-CERT-2026-000123.pdf");
    expect(certificateFilename({ ...CERT, certificate_id: "../../evil" })).not.toContain("/");
  });
});
