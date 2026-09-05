import { describe, expect, it } from "vitest";
import { formatCertificateId, isCertificateIdShape } from "../src/lib/server/certificates";
import { certificateFilename, renderCertificatePdf } from "../src/lib/server/certificate-pdf";
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
  const pdf = renderCertificatePdf(CERT);
  const text = Buffer.from(pdf).toString("latin1");

  it("produces a structurally valid single-page PDF", () => {
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Count 1");
    expect(text).toContain("xref");
    expect(text).toContain("startxref");
    // A4 landscape.
    expect(text).toContain("/MediaBox [0 0 842 595]");
  });

  it("contains the real certificate data, not placeholders", () => {
    expect(text).toContain("John Doe");
    expect(text).toContain("Python Fundamentals");
    expect(text).toContain("MTRX-CERT-2026-000123");
    expect(text).toContain("100%");
  });

  it("has a byte-accurate xref table so viewers can open it", () => {
    const startxref = Number(text.match(/startxref\n(\d+)/)?.[1]);
    expect(Number.isFinite(startxref)).toBe(true);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(4);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it("escapes characters that would corrupt a PDF string", () => {
    const risky = renderCertificatePdf({ ...CERT, display_name: "A (B) \\ C" });
    const out = Buffer.from(risky).toString("latin1");
    expect(out).toContain("A \\(B\\) \\\\ C");
    expect(out.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("builds a safe download filename", () => {
    expect(certificateFilename(CERT)).toBe("MATRIX-MTRX-CERT-2026-000123.pdf");
    expect(certificateFilename({ ...CERT, certificate_id: "../../evil" })).not.toContain("/");
  });
});
