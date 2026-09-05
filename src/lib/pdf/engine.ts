// =============================================================================
// MATRIX PDF engine — the single PDF generator for the whole platform.
//
// Everything that produces a PDF (chat/document export, certificates, and any
// future generator) goes through `renderPdf` here. There is exactly one place
// where fonts are registered, text is shaped, and pages are laid out.
//
// Why PDFKit + embedded TrueType instead of the previous hand-rolled writer:
//
//   * The old writer emitted `(literal) Tj` against the standard 14 Type 1
//     fonts. Those are Latin-1 only, so every Bangla codepoint (and ✓ • → …)
//     was either dropped by a sanitiser or written as a byte the viewer could
//     not map — hence blank pages and empty parentheses.
//   * PDFKit embeds a real subset of a real TrueType font, writes glyph IDs in
//     a hex string, and ships a /ToUnicode CMap, so the text is both drawn and
//     extractable.
//   * Bangla additionally needs OpenType shaping (conjuncts, reordered vowel
//     signs like ি which is typed after but drawn before its consonant).
//     PDFKit runs fontkit's layout engine, which does this properly.
//
// Two things this module adds on top of PDFKit:
//
//   1. Per-character font fallback. A single string can mix Bangla, Latin and
//      symbols; we split it into runs and draw each run with a face that
//      actually has the glyph. Nothing is dropped and nothing is transliterated
//      away.
//   2. Correct text extraction. After shaping, glyphs are in *visual* order, so
//      a naive extraction returns reordered Bangla. Each drawn run is wrapped
//      in a marked-content span carrying /ActualText with the original logical
//      Unicode, which is what PDF readers, copy-paste and text extractors use.
// =============================================================================

import "server-only";
import PDFDocument from "pdfkit";
import {
  FACE_NAMES,
  type FaceName,
  type FontFamily,
  type FontWeight,
  faceForChar,
  fontBytes,
  isInvisible,
} from "@/lib/pdf/fonts";

// ---------------------------------------------------------------------------
// Public document model
// ---------------------------------------------------------------------------

export type Align = "left" | "center" | "right";

export type TextStyle = {
  size?: number;
  family?: FontFamily;
  weight?: FontWeight;
  color?: string;
  align?: Align;
  /** Extra space below the block, in points. */
  gap?: number;
  /** Line height multiplier. */
  leading?: number;
  /** Letter spacing, in points. */
  tracking?: number;
  /** Indent from the left content edge, in points. */
  indent?: number;
};

export type PdfBlock =
  | ({ type: "text"; text: string } & TextStyle)
  /** A horizontal rule across the content width. */
  | { type: "rule"; color?: string; thickness?: number; gap?: number; width?: number; align?: Align }
  | { type: "space"; height: number }
  /** Force a page break before the next block. */
  | { type: "page-break" }
  /** Absolutely positioned text, measured from the page origin (top-left). */
  | ({ type: "at"; text: string; x: number; y: number; maxWidth?: number } & TextStyle)
  /** A stroked rectangle in absolute page coordinates. */
  | { type: "rect"; x: number; y: number; width: number; height: number; color?: string; thickness?: number }
  /** A line in absolute page coordinates. */
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; color?: string; thickness?: number };

export type PdfDocumentSpec = {
  title?: string;
  author?: string;
  subject?: string;
  /** Page size in points, or a named size PDFKit understands. */
  size?: [number, number] | string;
  layout?: "portrait" | "landscape";
  margin?: number;
  margins?: { top: number; bottom: number; left: number; right: number };
  blocks: PdfBlock[];
  /** Draw a header/footer on every page. */
  footer?: string | null;
};

const DEFAULTS = {
  size: 11,
  family: "sans" as FontFamily,
  weight: "regular" as FontWeight,
  color: "#111111",
  align: "left" as Align,
  leading: 1.35,
  gap: 6,
};

// ---------------------------------------------------------------------------
// Run splitting — one contiguous chunk of text per usable face
// ---------------------------------------------------------------------------

export type Run = { face: FaceName; text: string };

/**
 * Split a string into runs that each render with a single embedded face.
 *
 * A character with no coverage in ANY embedded face becomes a visible
 * `\uFFFD`-style marker rather than disappearing: silently dropping text is
 * exactly the failure mode we are fixing. Combining marks always stay attached
 * to the run of the base character before them, so shaping is never split
 * mid-cluster.
 */
export function splitRuns(text: string, family: FontFamily, weight: FontWeight): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;

  for (const char of Array.from(text)) {
    if (isInvisible(char)) continue;
    const combining = isCombining(char);
    // Keep combining marks in the run of their base character — splitting a
    // cluster across two faces would break Bangla conjuncts.
    const face: FaceName | null = combining && current ? current.face : faceForChar(char, family, weight);

    if (!face) {
      // No embedded face has this glyph. Show it, don't swallow it.
      const marker = `\u25A1`; // WHITE SQUARE — the conventional "missing glyph".
      const fallback = faceForChar(marker, family, weight) ?? "sans";
      if (current && current.face === fallback) current.text += marker;
      else runs.push((current = { face: fallback, text: marker }));
      continue;
    }

    if (current && current.face === face) current.text += char;
    else runs.push((current = { face, text: char }));
  }

  return runs;
}

function isCombining(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x0981 && cp <= 0x0983) || // Bengali signs
    cp === 0x09bc ||
    (cp >= 0x09be && cp <= 0x09cd) || // Bengali vowel signs + virama
    cp === 0x09d7 ||
    (cp >= 0x200c && cp <= 0x200d) // ZWNJ / ZWJ
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Doc = PDFKit.PDFDocument;

/** UTF-16BE hex with a BOM — the encoding PDF text strings use for /ActualText. */
function utf16beHex(value: string): string {
  const buf = Buffer.from(`\uFEFF${value}`, "utf16le");
  buf.swap16();
  return buf.toString("hex");
}

const SHOW_TEXT = /(\]\s*TJ|\)\s*Tj)\s*$/;

/**
 * Grapheme clusters, used to keep complex-script text extractable.
 *
 * Bengali reorders glyphs during shaping — the vowel sign ি is typed AFTER its
 * consonant but drawn BEFORE it — so a whole shaped run emits glyphs in visual
 * order. Tagging the whole run with one /ActualText fixes readers that honour
 * it, but readers that fall back to /ToUnicode still return the reordered text.
 * Emitting one span per grapheme cluster makes BOTH paths correct, because a
 * cluster's glyphs never reorder past the cluster boundary. Bengali conjuncts
 * (ক্ষ, ত্ত, দ্ধ …) are single grapheme clusters, so shaping is untouched.
 */
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("bn", { granularity: "grapheme" }) : null;

function graphemeClusters(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

/** Faces whose text must be emitted cluster-by-cluster to stay extractable. */
function needsClusterSpans(face: FaceName): boolean {
  return face === "bengali" || face === "bengali-bold";
}

/**
 * Draw one run and tag it with the logical text.
 *
 * PDFKit emits several `TJ` operators per run (it repositions for every glyph
 * that carries an offset). We capture that output, wrap the whole group in a
 * single `/Span << /ActualText (…) >> BDC … EMC`, and let the viewer use the
 * logical string. Without this, extracting Bangla returns the visually
 * reordered glyph sequence.
 */
function drawTagged(doc: Doc, face: FaceName, text: string, logical: string, x: number, y: number, size: number, options: PDFKit.Mixins.TextOptions) {
  const original = doc.addContent.bind(doc);
  const captured: string[] = [];
  (doc as unknown as { addContent: (data: unknown) => Doc }).addContent = (data: unknown) => {
    captured.push(String(data));
    return doc;
  };
  try {
    doc.font(face).fontSize(size).text(text, x, y, { ...options, lineBreak: false });
  } finally {
    (doc as unknown as { addContent: (data: unknown) => Doc }).addContent = original;
  }

  // Each show-text operator gets its OWN span. The first carries the logical
  // text; any further ones carry an empty /ActualText so the extractor does not
  // append their (visually reordered) glyphs after it. Wrapping several
  // operators in a single span instead makes readers emit the ActualText *and*
  // the remaining glyph runs, which duplicates trailing characters.
  let seen = 0;
  for (const chunk of captured) {
    if (!SHOW_TEXT.test(chunk)) {
      original(chunk);
      continue;
    }
    const actual = seen === 0 ? utf16beHex(logical) : "feff";
    seen += 1;
    original(`/Span << /ActualText <${actual}> >> BDC`);
    original(chunk);
    original("EMC");
  }
}

/**
 * Draw one run at `x`, returning the advance width.
 *
 * Complex scripts are emitted one grapheme cluster at a time so that both
 * /ActualText-aware and /ToUnicode-only extractors recover the logical string;
 * simple scripts are drawn in a single shaped pass for compactness and proper
 * kerning.
 */
function drawRun(doc: Doc, run: Run, x: number, y: number, size: number, options: PDFKit.Mixins.TextOptions): number {
  doc.font(run.face).fontSize(size);

  if (!needsClusterSpans(run.face)) {
    drawTagged(doc, run.face, run.text, run.text, x, y, size, options);
    return doc.widthOfString(run.text, options);
  }

  let cursor = x;
  for (const cluster of graphemeClusters(run.text)) {
    drawTagged(doc, run.face, cluster, cluster, cursor, y, size, options);
    doc.font(run.face).fontSize(size);
    cursor += doc.widthOfString(cluster, options);
  }
  return cursor - x;
}

/** Width of a string when drawn with per-character fallback. */
export function measure(doc: Doc, text: string, style: Required<Pick<TextStyle, "size" | "family" | "weight">> & { tracking?: number }): number {
  const options = { characterSpacing: style.tracking ?? 0 };
  let width = 0;
  for (const run of splitRuns(text, style.family, style.weight)) {
    doc.font(run.face).fontSize(style.size);
    if (needsClusterSpans(run.face)) {
      // Must match how the run is actually drawn (cluster by cluster), or
      // centring and wrapping would drift away from the rendered text.
      for (const cluster of graphemeClusters(run.text)) width += doc.widthOfString(cluster, options);
    } else {
      width += doc.widthOfString(run.text, options);
    }
  }
  return width;
}

/** Greedy word wrap that measures with the same fallback used for drawing. */
function wrap(doc: Doc, text: string, maxWidth: number, style: { size: number; family: FontFamily; weight: FontWeight; tracking?: number }): string[] {
  const paragraphs = text.split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/(\s+)/).filter((w) => w !== "");
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (line && measure(doc, candidate, style) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
        // A single token longer than the line (a long URL, an unbroken
        // Bangla compound) is split by character rather than overflowing.
        while (measure(doc, line, style) > maxWidth) {
          let cut = line.length - 1;
          while (cut > 1 && measure(doc, line.slice(0, cut), style) > maxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }

  return lines;
}

function alignedX(align: Align, left: number, contentWidth: number, lineWidth: number): number {
  if (align === "center") return left + (contentWidth - lineWidth) / 2;
  if (align === "right") return left + contentWidth - lineWidth;
  return left;
}

/** Draw one already-wrapped line, run by run, at an aligned x. */
function drawLine(
  doc: Doc,
  line: string,
  y: number,
  left: number,
  contentWidth: number,
  style: { size: number; family: FontFamily; weight: FontWeight; color: string; align: Align; tracking?: number },
) {
  if (!line) return;
  const runs = splitRuns(line, style.family, style.weight);
  if (!runs.length) return;
  const total = measure(doc, line, style);
  let x = alignedX(style.align, left, contentWidth, total);
  doc.fillColor(style.color);
  for (const run of runs) {
    x += drawRun(doc, run, x, y, style.size, { characterSpacing: style.tracking ?? 0 });
  }
}

/**
 * Render a document spec to PDF bytes.
 *
 * Resolves once the PDF is fully flushed, so callers always get complete
 * bytes — a truncated stream is another way PDFs "come out blank".
 */
export function renderPdf(spec: PdfDocumentSpec): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const margins =
      spec.margins ??
      (typeof spec.margin === "number"
        ? { top: spec.margin, bottom: spec.margin, left: spec.margin, right: spec.margin }
        : { top: 56, bottom: 56, left: 56, right: 56 });

    const doc = new PDFDocument({
      size: spec.size ?? "A4",
      layout: spec.layout ?? "portrait",
      margins,
      autoFirstPage: true,
      // Required so footers can be stamped onto every page after layout.
      bufferPages: true,
      // Tagged output plus a language keeps assistive tech and extractors happy.
      pdfVersion: "1.7",
      lang: "en",
      displayTitle: true,
      info: {
        Title: spec.title || "MATRIX document",
        Author: spec.author || "MATRIX",
        Subject: spec.subject || "",
        Producer: "MATRIX PDF engine",
        Creator: "MATRIX",
      },
    });

    // Register every face up front so any block can fall back to any of them.
    for (const face of FACE_NAMES) doc.registerFont(face, fontBytes(face));
    doc.font("sans");

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const left = margins.left;
    const contentWidth = pageWidth - margins.left - margins.right;
    const bottom = pageHeight - margins.bottom;

    let cursorY = margins.top;
    let pageIndex = 0;

    const footers: Array<{ page: number }> = [{ page: 0 }];

    function newPage() {
      doc.addPage();
      pageIndex += 1;
      footers.push({ page: pageIndex });
      cursorY = margins.top;
    }

    function ensureRoom(height: number) {
      if (cursorY + height <= bottom) return;
      newPage();
    }

    for (const block of spec.blocks) {
      if (block.type === "page-break") {
        newPage();
        continue;
      }

      if (block.type === "space") {
        ensureRoom(block.height);
        cursorY += block.height;
        continue;
      }

      if (block.type === "rule") {
        const thickness = block.thickness ?? 0.75;
        const width = block.width ?? contentWidth;
        ensureRoom(thickness + 8);
        const x = alignedX(block.align ?? "left", left, contentWidth, width);
        doc
          .save()
          .lineWidth(thickness)
          .strokeColor(block.color ?? "#d6d9e0")
          .moveTo(x, cursorY)
          .lineTo(x + width, cursorY)
          .stroke()
          .restore();
        cursorY += thickness + (block.gap ?? 10);
        continue;
      }

      if (block.type === "rect") {
        doc
          .save()
          .lineWidth(block.thickness ?? 1)
          .strokeColor(block.color ?? "#d6d9e0")
          .rect(block.x, block.y, block.width, block.height)
          .stroke()
          .restore();
        continue;
      }

      if (block.type === "line") {
        doc
          .save()
          .lineWidth(block.thickness ?? 1)
          .strokeColor(block.color ?? "#d6d9e0")
          .moveTo(block.x1, block.y1)
          .lineTo(block.x2, block.y2)
          .stroke()
          .restore();
        continue;
      }

      const size = block.size ?? DEFAULTS.size;
      const family = block.family ?? DEFAULTS.family;
      const weight = block.weight ?? DEFAULTS.weight;
      const color = block.color ?? DEFAULTS.color;
      const align = block.align ?? DEFAULTS.align;
      const leading = (block.leading ?? DEFAULTS.leading) * size;
      const tracking = block.tracking ?? 0;
      const style = { size, family, weight, color, align, tracking };

      if (block.type === "at") {
        const width = block.maxWidth ?? pageWidth - block.x * 2;
        const lines = wrap(doc, block.text, width, style);
        let y = block.y;
        for (const line of lines) {
          drawLine(doc, line, y, block.x, width, style);
          y += leading;
        }
        continue;
      }

      // Flowing text.
      const indent = block.indent ?? 0;
      const lines = wrap(doc, block.text, contentWidth - indent, style);
      for (const line of lines) {
        ensureRoom(leading);
        drawLine(doc, line, cursorY, left + indent, contentWidth - indent, style);
        cursorY += leading;
      }
      cursorY += block.gap ?? DEFAULTS.gap;
    }

    // Footers, drawn after all content so page numbers are final.
    if (spec.footer) {
      const total = footers.length;
      const range = doc.bufferedPageRange?.();
      for (let i = 0; i < total; i++) {
        if (range) {
          try {
            doc.switchToPage(range.start + i);
          } catch {
            break;
          }
        } else if (i > 0) {
          break;
        }
        const text = `${spec.footer}  ·  ${i + 1} / ${total}`;
        const footerStyle = { size: 8, family: "sans" as FontFamily, weight: "regular" as FontWeight, color: "#8a8f99", align: "center" as Align };
        drawLine(doc, text, pageHeight - margins.bottom + 22, left, contentWidth, footerStyle);
      }
    }

    doc.end();
  });
}
