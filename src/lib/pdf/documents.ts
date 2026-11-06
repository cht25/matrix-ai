// =============================================================================
// MATRIX document PDFs — the shared, high-level generators.
//
// Everything on top of `renderPdf`:
//   * `renderDocumentPdf` — chat exports, document exports, any Markdown-ish
//     text. Headings, bullets, numbered lists, quotes, code blocks and rules
//     become real typographic blocks.
//   * `renderCertificatePdf` — the A4 landscape certificate.
//
// Both go through the one engine, so Unicode behaves identically everywhere.
// =============================================================================

import "server-only";
import { renderPdf, type PdfBlock, type PdfDocumentSpec } from "@/lib/pdf/engine";

// ---------------------------------------------------------------------------
// Markdown → blocks
// ---------------------------------------------------------------------------

/** Strip inline Markdown emphasis without touching any non-Latin text. */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * Turn Markdown-ish text into layout blocks.
 *
 * Deliberately conservative: anything it does not recognise becomes a normal
 * paragraph. No character is ever discarded — the whole point of this rewrite.
 */
export function markdownToBlocks(markdown: string): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");

  let inCode = false;
  let code: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "text", text: stripInline(paragraph.join(" ")).trim(), size: 10.5, gap: 8, leading: 1.45 });
    paragraph = [];
  };

  const flushCode = () => {
    if (!code.length) {
      code = [];
      return;
    }
    blocks.push({
      type: "text",
      text: code.join("\n"),
      family: "mono",
      size: 9,
      color: "#22303f",
      leading: 1.4,
      gap: 10,
      indent: 10,
    });
    code = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");

    if (/^\s*```/.test(line)) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const size = level === 1 ? 18 : level === 2 ? 15 : level === 3 ? 13 : 11.5;
      blocks.push({
        type: "text",
        text: stripInline(heading[2]).trim(),
        size,
        weight: "bold",
        color: "#0b1220",
        gap: level <= 2 ? 8 : 6,
        leading: 1.3,
      });
      if (level === 1) blocks.push({ type: "rule", gap: 10 });
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\W]*$/.test(line) && !/\w/.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule", gap: 10 });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*•]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      const depth = Math.min(3, Math.floor(bullet[1].length / 2));
      blocks.push({
        type: "text",
        text: `•  ${stripInline(bullet[2]).trim()}`,
        size: 10.5,
        gap: 3,
        leading: 1.4,
        indent: 12 + depth * 14,
      });
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      const depth = Math.min(3, Math.floor(numbered[1].length / 2));
      blocks.push({
        type: "text",
        text: `${numbered[2]}.  ${stripInline(numbered[3]).trim()}`,
        size: 10.5,
        gap: 3,
        leading: 1.4,
        indent: 12 + depth * 14,
      });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push({
        type: "text",
        text: stripInline(quote[1]).trim(),
        size: 10.5,
        color: "#4a5261",
        gap: 6,
        leading: 1.45,
        indent: 16,
      });
      continue;
    }

    // Markdown table rows keep their structure as monospaced lines rather than
    // being mangled into prose.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      blocks.push({
        type: "text",
        text: stripInline(line.trim()),
        family: "mono",
        size: 9,
        gap: 2,
        leading: 1.35,
      });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  if (inCode) flushCode();

  return blocks;
}

// ---------------------------------------------------------------------------
// Document / chat export
// ---------------------------------------------------------------------------

export type DocumentPdfOptions = {
  title?: string;
  subtitle?: string | null;
  footer?: string | null;
  author?: string;
};

/** A paginated A4 document from Markdown-ish content. Used for every export. */
export function renderDocumentPdf(content: string, options: DocumentPdfOptions = {}): Promise<Uint8Array> {
  const title = (options.title ?? "MATRIX document").trim() || "MATRIX document";

  // If the content already opens with the same H1, drop it — otherwise the
  // document header and the first heading say the same thing twice.
  const source = (content ?? "").replace(/^\s*#\s+(.*)\s*\n?/, (match, heading: string) =>
    stripInline(String(heading)).trim() === title ? "" : match,
  );

  const blocks: PdfBlock[] = [
    { type: "text", text: title, size: 20, weight: "bold", color: "#0b1220", gap: options.subtitle ? 4 : 8, leading: 1.25 },
  ];
  if (options.subtitle) {
    blocks.push({ type: "text", text: options.subtitle, size: 10, color: "#6b7280", gap: 8 });
  }
  blocks.push({ type: "rule", gap: 14 });

  const body = markdownToBlocks(source);
  blocks.push(...(body.length ? body : [{ type: "text", text: source, size: 10.5 } as PdfBlock]));

  const spec: PdfDocumentSpec = {
    title,
    author: options.author ?? "MATRIX",
    size: "A4",
    margins: { top: 56, bottom: 62, left: 56, right: 56 },
    footer: options.footer ?? "MATRIX",
    blocks,
  };
  return renderPdf(spec);
}

// ---------------------------------------------------------------------------
// Certificate
// ---------------------------------------------------------------------------

export type CertificatePdfData = {
  certificate_id: string;
  course: string;
  display_name: string;
  score_percent: number;
  issued_at: string;
  issued_by: string;
};

const CERT_W = 842; // A4 landscape
const CERT_H = 595;

function formatIssued(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * The certificate document — A4 landscape, certificate content only.
 *
 * This is generated server-side from the certificate record, so it can never
 * contain navigation, the chat UI or any other application chrome.
 */
export function renderCertificatePdf(cert: CertificatePdfData): Promise<Uint8Array> {
  const name = cert.display_name?.trim() || "MATRIX learner";
  const course = cert.course?.trim() || "Course";
  const score = `${Math.round(Number(cert.score_percent) || 0)}%`;
  const centre = (text: string, y: number, extra: Partial<PdfBlock> = {}): PdfBlock =>
    ({ type: "at", text, x: 60, y, maxWidth: CERT_W - 120, align: "center", ...extra }) as PdfBlock;

  const columns: Array<[string, string, "sans" | "mono"]> = [
    ["SCORE", score, "sans"],
    ["COMPLETED", formatIssued(cert.issued_at), "sans"],
    ["CERTIFICATE ID", cert.certificate_id, "mono"],
  ];
  const colWidth = (CERT_W - 200) / columns.length;

  const blocks: PdfBlock[] = [
    { type: "rect", x: 28, y: 28, width: CERT_W - 56, height: CERT_H - 56, color: "#1d2433", thickness: 1.5 },
    { type: "rect", x: 40, y: 40, width: CERT_W - 80, height: CERT_H - 80, color: "#c3c8d2", thickness: 0.6 },

    centre("MATRIX", 74, { size: 27, weight: "bold", color: "#0b1220", tracking: 6 }),
    centre("CERTIFICATE OF COMPLETION", 116, { size: 11, color: "#6b7280", tracking: 3.4 }),
    { type: "line", x1: 330, y1: 142, x2: 512, y2: 142, color: "#c3c8d2", thickness: 0.8 },

    centre("This certifies that", 178, { size: 11, color: "#6b7280" }),
    centre(name, 204, { size: 30, weight: "bold", color: "#0b1220" }),
    centre("has successfully completed", 258, { size: 11, color: "#6b7280" }),
    centre(course, 282, { size: 17, weight: "bold", color: "#1d2433" }),

    { type: "line", x1: 280, y1: 330, x2: 562, y2: 330, color: "#d6d9e0", thickness: 0.6 },
  ];

  columns.forEach(([label, value, family], index) => {
    const x = 100 + colWidth * index;
    blocks.push({ type: "at", text: label, x, y: 362, maxWidth: colWidth, align: "center", size: 8, color: "#8a8f99", tracking: 1.5 });
    blocks.push({
      type: "at",
      text: value,
      x,
      y: 380,
      maxWidth: colWidth,
      align: "center",
      size: family === "mono" ? 11 : 13,
      family,
      weight: family === "mono" ? "regular" : "bold",
      color: "#0b1220",
    });
  });

  blocks.push(
    { type: "line", x1: 100, y1: 452, x2: CERT_W - 100, y2: 452, color: "#e2e5ea", thickness: 0.6 },
    centre(cert.issued_by || "MATRIX", 470, { size: 9, color: "#6b7280" }),
    centre(`Verify at /certificate/verify/${cert.certificate_id}`, 492, { size: 8, family: "mono", color: "#8a8f99" }),
    centre("MATRIX", 520, { size: 10, weight: "bold", color: "#4a5261", tracking: 4 }),
  );

  return renderPdf({
    title: `MATRIX Certificate ${cert.certificate_id}`,
    subject: `${course} — ${name}`,
    author: cert.issued_by || "MATRIX",
    size: [CERT_W, CERT_H],
    margins: { top: 40, bottom: 40, left: 40, right: 40 },
    blocks,
  });
}

/** Safe download filename for a certificate. */
export function certificateFilename(cert: { certificate_id: string }): string {
  const id = cert.certificate_id.replace(/[^A-Za-z0-9-]/g, "") || "certificate";
  return `MATRIX-${id}.pdf`;
}
