// =============================================================================
// MATRIX response exporters — real files, built in the browser.
//
// Every format here is genuinely produced (PDF pages, zipped OOXML for DOCX and
// XLSX, CSV from detected tabular data, JSON from detected structured data).
// The UI only calls into this module when the user asked for an artifact, so
// nothing is generated speculatively.
// =============================================================================

import { toBlobBytes, zipStore } from "@/lib/export/zip";
import type { ExportFormat } from "@/lib/ai/intent";

export const EXPORT_MIME: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  markdown: "text/markdown;charset=utf-8",
  txt: "text/plain;charset=utf-8",
  json: "application/json",
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  pdf: "pdf",
  docx: "docx",
  markdown: "md",
  txt: "txt",
  json: "json",
  csv: "csv",
  xlsx: "xlsx",
};

export type BuiltArtifact = {
  filename: string;
  mime: string;
  data: BlobPart;
  /** Plain-text preview (null for binary-only formats). */
  preview: string | null;
};

export function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "matrix-response"
  );
}

export function exportFilename(format: ExportFormat, title: string): string {
  return `${slugifyTitle(title)}.${EXPORT_EXTENSION[format]}`;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?|```/g, ""))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[#*_`]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .trim();
}

export function exportMarkdown(content: string, title = "MATRIX response"): string {
  return `# ${title}\n\n${content.trim()}\n`;
}

export function exportJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Tabular data → CSV / XLSX
// ---------------------------------------------------------------------------

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/**
 * Pull rows out of a reply: a Markdown table first, then a fenced csv/tsv
 * block, then comma-separated lines. Returns null when the reply holds no
 * tabular data at all — callers must not invent a spreadsheet.
 */
export function extractTableRows(markdown: string): string[][] | null {
  const lines = (markdown ?? "").split("\n");

  // 1. Markdown table (header row + ---|--- divider).
  for (let i = 1; i < lines.length; i++) {
    const divider = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i]);
    if (!divider || !lines[i - 1].includes("|")) continue;
    const rows: string[][] = [splitRow(lines[i - 1])];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line || !line.includes("|")) break;
      rows.push(splitRow(line));
    }
    if (rows.length >= 2) return rows;
  }

  // 2. Fenced csv/tsv block.
  const fence = markdown.match(/```(?:csv|tsv)\s*\n([\s\S]*?)```/i);
  if (fence) {
    const body = fence[1].trim();
    if (body) {
      const separator = /```tsv/i.test(markdown) ? "\t" : ",";
      return body.split("\n").filter(Boolean).map((line) => parseDelimited(line, separator));
    }
  }

  // 3. Loose comma-separated lines (3+ rows, consistent column count).
  const csvLines = lines.filter((line) => line.includes(",") && !/^\s*(?:#|[-*•]|\d+[.)]|>)/.test(line) && line.trim().length > 0);
  if (csvLines.length >= 3) {
    const counts = csvLines.slice(0, 8).map((line) => parseDelimited(line, ",").length);
    if (counts.every((count) => count >= 2 && count === counts[0])) {
      return csvLines.map((line) => parseDelimited(line, ","));
    }
  }

  return null;
}

function parseDelimited(line: string, separator: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (char === '"') quoted = false;
      else current += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === separator) { cells.push(current.trim()); current = ""; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function csvCell(value: string): string {
  const needsQuotes = /[",\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

export function rowsToCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** CSV for a reply, or null when the reply has no tabular data. */
export function exportCsv(content: string): string | null {
  const rows = extractTableRows(content);
  return rows ? rowsToCsv(rows) : null;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function isNumericCell(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim()) && value.trim().length < 16 && !/^0\d/.test(value.trim());
}

/** A real .xlsx package (stored ZIP + SpreadsheetML worksheet). */
export function exportXlsxBytes(rows: string[][], sheetName = "Matrix"): Uint8Array<ArrayBuffer> {
  const name = sheetName.replace(/[\\/*?:\[\]]/g, "").slice(0, 31) || "Matrix";
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const ref = `${columnLetter(colIndex)}${rowIndex + 1}`;
          const text = value ?? "";
          if (isNumericCell(text)) return `<c r="${ref}"><v>${text.trim()}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;

  return zipStore([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

// ---------------------------------------------------------------------------
// DOCX — a real zipped OOXML package
// ---------------------------------------------------------------------------

type DocParagraph = { text: string; style: "heading" | "body" | "bullet" | "mono" };

function docParagraphs(markdown: string, title: string): DocParagraph[] {
  const paragraphs: DocParagraph[] = [{ text: title, style: "heading" }];
  const lines = (markdown ?? "").split("\n");
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) {
      if (line.trim()) paragraphs.push({ text: line.replace(/\t/g, "    "), style: "mono" });
      continue;
    }
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { paragraphs.push({ text: heading[2].trim(), style: "heading" }); continue; }
    const bullet = line.match(/^\s*(?:[-*•]\s+|\d+[.)]\s+)(.*)$/);
    if (bullet) { paragraphs.push({ text: bullet[1].trim(), style: "bullet" }); continue; }
    paragraphs.push({ text: line.replace(/^\s*>\s?/, "").trim(), style: "body" });
  }
  return paragraphs;
}

function docRun(text: string, style: DocParagraph["style"]): string {
  const bold = style === "heading" ? "<w:b/>" : "";
  const font = style === "mono" ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : "";
  const size = style === "heading" ? '<w:sz w:val="28"/>' : style === "mono" ? '<w:sz w:val="20"/>' : "";
  return `<w:r><w:rPr>${font}${bold}${size}</w:rPr><w:t xml:space="preserve">${escapeXml(inlineMarkdownToText(text))}</w:t></w:r>`;
}

function inlineMarkdownToText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

export function exportDocxBytes(markdown: string, title = "MATRIX response"): Uint8Array<ArrayBuffer> {
  const body = docParagraphs(markdown, title)
    .map((paragraph) => {
      const numbering = paragraph.style === "bullet" ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "";
      const spacing = '<w:spacing w:after="120"/>';
      return `<w:p><w:pPr>${numbering}${spacing}</w:pPr>${docRun(paragraph.text, paragraph.style)}</w:p>`;
    })
    .join("");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  return zipStore([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "word/_rels/document.xml.rels", data: documentRels },
    { name: "word/document.xml", data: documentXml },
    { name: "word/numbering.xml", data: numbering },
  ]);
}

// ---------------------------------------------------------------------------
// PDF — produced by the one shared MATRIX PDF engine
// ---------------------------------------------------------------------------
//
// PDFs are NOT built in the browser. Real Unicode output needs embedded
// TrueType subsets and OpenType shaping (Bangla conjuncts, reordered vowel
// signs, symbols), which is what `lib/pdf/engine` does server-side. The old
// in-browser writer used the standard 14 Type 1 fonts and stripped every
// non-Latin-1 character, which is why exports came out blank or garbled.
//
// This helper posts the content to `/api/export/pdf` and returns the bytes.

export async function requestPdfBytes(content: string, title = "MATRIX"): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch("/api/export/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, title }),
  });
  if (!res.ok) throw new Error(`PDF_EXPORT_FAILED_${res.status}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength < 1000) throw new Error("PDF_EXPORT_EMPTY");
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/** The first JSON payload in a reply (fenced block or bare object/array). */
export function extractJson(content: string): string | null {
  const fenced = content.match(/```(?:json|jsonc)?\s*\n([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1].trim());
  const bare = content.match(/([{\[][\s\S]*[}\]])/);
  if (bare) candidates.push(bare[1].trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.stringify(JSON.parse(candidate), null, 2);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One entry point for every artifact build
// ---------------------------------------------------------------------------

/**
 * Build the requested artifact from a reply. Returns null when the content
 * cannot honestly produce that format (e.g. CSV for prose) — the UI then says
 * so instead of handing the user an empty file.
 *
 * Async because PDFs are rendered by the shared server-side engine (embedded
 * Unicode fonts + OpenType shaping); every other format is built locally.
 */
export async function buildArtifact(format: ExportFormat, content: string, title = "MATRIX response"): Promise<BuiltArtifact | null> {
  const filename = exportFilename(format, title);
  const mime = EXPORT_MIME[format];
  const source = content ?? "";
  if (!source.trim()) return null;

  switch (format) {
    case "pdf":
      // Real Unicode PDFs are rendered by the shared server-side engine.
      return { filename, mime, data: await requestPdfBytes(source, title), preview: null };
    case "docx":
      return { filename, mime, data: exportDocxBytes(source, title), preview: null };
    case "markdown": {
      const text = exportMarkdown(source, title);
      return { filename, mime, data: text, preview: text };
    }
    case "txt": {
      const text = toPlainText(source);
      return { filename, mime, data: text, preview: text };
    }
    case "json": {
      const extracted = extractJson(source);
      const text =
        extracted ??
        exportJson({ title, content: toPlainText(source), exported_at: new Date().toISOString(), source: "matrix-response" });
      return { filename, mime, data: text, preview: text };
    }
    case "csv": {
      const text = exportCsv(source);
      if (!text) return null;
      return { filename, mime, data: text, preview: text };
    }
    case "xlsx": {
      const rows = extractTableRows(source);
      if (!rows) return null;
      return { filename, mime, data: exportXlsxBytes(rows, title.slice(0, 31)), preview: null };
    }
    default:
      return null;
  }
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // OOXML forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
