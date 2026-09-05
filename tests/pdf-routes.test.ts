// Route-level tests for the shared PDF endpoints — they must return real,
// non-empty PDF bytes with the right headers, and must reject junk rather than
// emitting a broken file.

import { describe, expect, it } from "vitest";
import { POST as exportPdf } from "../src/app/api/export/pdf/route";
import { GET as devCertificatePdf } from "../src/app/api/dev-preview/certificate/pdf/route";
import { extractPdfText, mediaBoxes, pageCount } from "./helpers/pdf-text";

const BANGLA = "আমি বাংলায় পরীক্ষা করছি। এটি Matrix AI-এর একটি পরীক্ষা।";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/export/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/export/pdf", () => {
  it("returns a real PDF containing the submitted Unicode text", async () => {
    const res = await exportPdf(jsonRequest({ content: `# Matrix AI Platform\n\n${BANGLA}\n`, title: "Matrix AI Platform" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(10_000);
    expect(Number(res.headers.get("Content-Length"))).toBe(bytes.byteLength);
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF-")).toBe(true);

    const text = await extractPdfText(bytes);
    expect(text).toContain("Matrix AI Platform");
    expect(text).toContain(BANGLA);
  });

  it("rejects empty, oversized and malformed requests", async () => {
    expect((await exportPdf(jsonRequest({ content: "   " }))).status).toBe(400);
    expect((await exportPdf(jsonRequest({ content: "x".repeat(500_000) }))).status).toBe(413);
    const broken = new Request("http://localhost/api/export/pdf", { method: "POST", body: "not json" });
    expect((await exportPdf(broken)).status).toBe(400);
  });
});

describe("GET /api/dev-preview/certificate/pdf", () => {
  it("returns a one-page A4 landscape certificate", async () => {
    const res = await devCertificatePdf(new Request("http://localhost/api/dev-preview/certificate/pdf?name=Test%20User"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(pageCount(bytes)).toBe(1);
    expect(mediaBoxes(bytes)).toEqual([[842, 595]]);

    const text = await extractPdfText(bytes);
    expect(text).toContain("Test User");
    expect(text).toContain("Python Fundamentals");
    expect(text).toContain("MTRX-CERT-2026-000123");
  });
});
