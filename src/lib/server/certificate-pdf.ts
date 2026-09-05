// =============================================================================
// MATRIX certificate PDF.
//
// A self-contained, dependency-free PDF 1.4 writer that renders ONLY the
// certificate — never the surrounding application page. One A4 landscape page
// (842 x 595 pt) using the standard Type 1 fonts, so the file stays a few KB
// and needs no embedded font blobs.
// =============================================================================

import type { PublicCertificate } from "@/lib/server/certificates";

const PAGE_W = 842;
const PAGE_H = 595;

/** Escape a string for a PDF literal string object. */
function pdfEscape(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}

// Typographic characters the standard 14 fonts cannot encode, mapped to their
// closest ASCII form so names and titles read correctly instead of showing "?".
const TRANSLITERATE: Record<string, string> = {
  "—": "-", "–": "-", "‑": "-", "−": "-",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "‘": "'", "’": "'", "‚": "'", "›": ">", "‹": "<",
  "…": "...", "•": "-", "·": "-", "→": "->", "×": "x",
  "\u00a0": " ", "\u202f": " ", "\u2009": " ",
};

/** WinAnsi-safe text for the standard Type 1 fonts. */
function sanitize(text: string): string {
  return Array.from(text ?? "")
    .map((ch) => {
      const mapped = TRANSLITERATE[ch];
      if (mapped !== undefined) return mapped;
      const code = ch.charCodeAt(0);
      return code >= 32 && code <= 255 ? ch : "";
    })
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Average glyph widths (per 1000 units) — good enough for centring text.
const WIDTH_FACTOR: Record<string, number> = { Helvetica: 0.5, "Helvetica-Bold": 0.55, Courier: 0.6 };

function textWidth(text: string, font: string, size: number): number {
  return text.length * (WIDTH_FACTOR[font] ?? 0.5) * size;
}

type Op = string;

function centeredText(text: string, y: number, font: string, size: number, gray: number, tracking = 0): Op {
  const clean = pdfEscape(sanitize(text));
  const width = textWidth(clean, font, size) + tracking * Math.max(0, clean.length - 1);
  const x = (PAGE_W - width) / 2;
  return [
    "BT",
    `/${font === "Helvetica-Bold" ? "F2" : font === "Courier" ? "F3" : "F1"} ${size} Tf`,
    tracking ? `${tracking} Tc` : "0 Tc",
    `${gray} g`,
    `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
    `(${clean}) Tj`,
    "ET",
  ].join("\n");
}

function line(x1: number, y1: number, x2: number, y2: number, gray: number, width = 1): Op {
  return `${gray} G\n${width} w\n${x1} ${y1} m\n${x2} ${y2} l\nS`;
}

function rect(x: number, y: number, w: number, h: number, gray: number, width = 1): Op {
  return `${gray} G\n${width} w\n${x} ${y} ${w} ${h} re\nS`;
}

function formatIssued(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
}

/** Build the page content stream for a certificate. */
export function certificateContentStream(cert: PublicCertificate): string {
  const ops: Op[] = [];

  // Outer + inner frame.
  ops.push(rect(28, 28, PAGE_W - 56, PAGE_H - 56, 0.15, 1.5));
  ops.push(rect(40, 40, PAGE_W - 80, PAGE_H - 80, 0.75, 0.6));

  ops.push(centeredText("M A T R I X", 500, "Helvetica-Bold", 26, 0.08, 2));
  ops.push(centeredText("CERTIFICATE OF COMPLETION", 466, "Helvetica", 11, 0.45, 3));
  ops.push(line(330, 452, 512, 452, 0.75, 0.8));

  ops.push(centeredText("This certifies that", 412, "Helvetica", 11, 0.45));
  ops.push(centeredText(cert.display_name || "MATRIX learner", 370, "Helvetica-Bold", 30, 0.08));
  ops.push(centeredText("has successfully completed", 330, "Helvetica", 11, 0.45));
  ops.push(centeredText(cert.course || "Course", 296, "Helvetica-Bold", 17, 0.12));

  ops.push(line(280, 262, 562, 262, 0.8, 0.6));

  // Metadata row — label above value, evenly spaced.
  const cols: Array<[string, string]> = [
    ["SCORE", `${Math.round(cert.score_percent)}%`],
    ["COMPLETED", formatIssued(cert.issued_at)],
    ["CERTIFICATE ID", cert.certificate_id],
  ];
  const colWidth = (PAGE_W - 200) / cols.length;
  cols.forEach(([label, value], i) => {
    const centre = 100 + colWidth * i + colWidth / 2;
    const labelClean = pdfEscape(sanitize(label));
    const valueClean = pdfEscape(sanitize(value));
    const lx = centre - (textWidth(labelClean, "Helvetica", 8) + 1.5 * (labelClean.length - 1)) / 2;
    const isId = label === "CERTIFICATE ID";
    const vFont = isId ? "Courier" : "Helvetica-Bold";
    const vSize = isId ? 11 : 13;
    const vx = centre - textWidth(valueClean, vFont, vSize) / 2;
    ops.push(`BT\n/F1 8 Tf\n1.5 Tc\n0.5 g\n1 0 0 1 ${lx.toFixed(2)} 224 Tm\n(${labelClean}) Tj\nET`);
    ops.push(`BT\n/${isId ? "F3" : "F2"} ${vSize} Tf\n0 Tc\n0.1 g\n1 0 0 1 ${vx.toFixed(2)} 200 Tm\n(${valueClean}) Tj\nET`);
  });

  ops.push(line(100, 128, PAGE_W - 100, 128, 0.85, 0.6));
  ops.push(centeredText(cert.issued_by, 104, "Helvetica", 9, 0.5));
  ops.push(centeredText(`Verify at /certificate/verify/${cert.certificate_id}`, 84, "Courier", 8, 0.6));
  ops.push(centeredText("M A T R I X", 60, "Helvetica-Bold", 10, 0.35, 2));

  return ops.join("\n");
}

/** Render a complete PDF document as bytes. */
export function renderCertificatePdf(cert: PublicCertificate): Uint8Array {
  const content = certificateContentStream(cert);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    `<< /Title (MATRIX Certificate ${pdfEscape(sanitize(cert.certificate_id))}) /Producer (MATRIX) /Creator (MATRIX) >>`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** Safe download filename for a certificate. */
export function certificateFilename(cert: PublicCertificate): string {
  const id = cert.certificate_id.replace(/[^A-Za-z0-9-]/g, "") || "certificate";
  return `MATRIX-${id}.pdf`;
}
