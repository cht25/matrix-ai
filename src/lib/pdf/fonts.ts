// =============================================================================
// MATRIX PDF fonts — real, Unicode-capable TrueType faces embedded as subsets.
//
// The legacy exporters used the PDF "standard 14" Type 1 fonts (Helvetica /
// Courier with WinAnsiEncoding). Those fonts physically cannot encode anything
// outside Latin-1, which is why Bangla and most symbols came out blank,
// garbled, or stripped. There is no way to patch around that: the fix is to
// embed real fonts.
//
// Two families cover everything the platform produces:
//
//   MatrixSans / MatrixMono  — DejaVu Sans / Sans Mono (~5.9k glyphs: Latin,
//                              Greek, Cyrillic, punctuation, arrows, maths,
//                              ✓ • → — … ★ √ and the rest of the symbol set).
//   MatrixBengali            — Noto Sans Bengali (Bengali/Bangla, including
//                              conjuncts and reordered vowel signs, which need
//                              real OpenType shaping).
//
// Fonts are read from disk at first use and cached for the process lifetime.
// =============================================================================

import "server-only";
import fs from "node:fs";
import path from "node:path";

export type FontWeight = "regular" | "bold";
export type FontFamily = "sans" | "mono";

/** Logical faces registered with every document. */
export type FaceName =
  | "sans"
  | "sans-bold"
  | "mono"
  | "mono-bold"
  | "bengali"
  | "bengali-bold";

const FILES: Record<FaceName, string> = {
  sans: "MatrixSans-Regular.ttf",
  "sans-bold": "MatrixSans-Bold.ttf",
  mono: "MatrixMono-Regular.ttf",
  "mono-bold": "MatrixMono-Bold.ttf",
  bengali: "MatrixBengali-Regular.ttf",
  "bengali-bold": "MatrixBengali-Bold.ttf",
};

export const FACE_NAMES = Object.keys(FILES) as FaceName[];

// `process.cwd()` is the project root under `next dev`, `next start` and
// vitest alike. The standalone build output keeps `src` traced because these
// files are required through `fs` — see `outputFileTracingIncludes` in
// next.config.ts.
const FONT_DIR = path.join(process.cwd(), "src", "lib", "pdf", "fonts");

const cache = new Map<FaceName, Buffer>();

export function fontPath(face: FaceName): string {
  return path.join(FONT_DIR, FILES[face]);
}

/** Raw TrueType bytes for a face (cached). */
export function fontBytes(face: FaceName): Buffer {
  const cached = cache.get(face);
  if (cached) return cached;
  const bytes = fs.readFileSync(fontPath(face));
  cache.set(face, bytes);
  return bytes;
}

// ---------------------------------------------------------------------------
// Coverage — which face can actually draw a given character
// ---------------------------------------------------------------------------

/**
 * Bengali block plus the Devanagari danda/double-danda that Bangla uses for
 * sentence punctuation (U+0964 / U+0965), and the two joiners that drive
 * conjunct formation.
 */
const BENGALI_RE = /[\u0980-\u09FF\u0964\u0965\u200C\u200D]/;

export function isBengali(char: string): boolean {
  return BENGALI_RE.test(char);
}

/** Characters that never need a glyph of their own. */
export function isInvisible(char: string): boolean {
  return char === "\u200B" || char === "\uFEFF" || char === "\u00AD";
}

/**
 * Codepoints each face can render, lazily derived from the font's own `cmap`.
 * Read straight from the file, so coverage can never drift from the bytes we
 * actually embed.
 */
const coverage = new Map<FaceName, Set<number>>();

export function faceCoverage(face: FaceName): Set<number> {
  const cached = coverage.get(face);
  if (cached) return cached;
  const set = readCmap(fontBytes(face));
  coverage.set(face, set);
  return set;
}

export function faceSupports(face: FaceName, codePoint: number): boolean {
  return faceCoverage(face).has(codePoint);
}

/** Minimal TrueType `cmap` reader (formats 4, 6 and 12). */
function readCmap(buf: Buffer): Set<number> {
  const out = new Set<number>();
  const numTables = buf.readUInt16BE(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) === "cmap") {
      cmapOffset = buf.readUInt32BE(rec + 8);
      break;
    }
  }
  if (cmapOffset < 0) return out;

  const numSub = buf.readUInt16BE(cmapOffset + 2);
  const subtables: number[] = [];
  for (let i = 0; i < numSub; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = cmapOffset + buf.readUInt32BE(rec + 4);
    // Unicode (0, *) and Windows BMP/full (3, 1) / (3, 10).
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
      subtables.push(offset);
    }
  }

  for (const offset of subtables) {
    const format = buf.readUInt16BE(offset);
    if (format === 4) {
      const segCountX2 = buf.readUInt16BE(offset + 6);
      const segCount = segCountX2 / 2;
      const endBase = offset + 14;
      const startBase = endBase + segCountX2 + 2;
      const deltaBase = startBase + segCountX2;
      const rangeBase = deltaBase + segCountX2;
      for (let s = 0; s < segCount; s++) {
        const end = buf.readUInt16BE(endBase + s * 2);
        const start = buf.readUInt16BE(startBase + s * 2);
        if (start > end || start === 0xffff) continue;
        const delta = buf.readInt16BE(deltaBase + s * 2);
        const rangeOffset = buf.readUInt16BE(rangeBase + s * 2);
        for (let c = start; c <= end && c !== 0x10000; c++) {
          let gid: number;
          if (rangeOffset === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            const gi = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
            if (gi + 1 >= buf.length) continue;
            const raw = buf.readUInt16BE(gi);
            gid = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (gid !== 0) out.add(c);
        }
      }
    } else if (format === 6) {
      const first = buf.readUInt16BE(offset + 6);
      const count = buf.readUInt16BE(offset + 8);
      for (let i = 0; i < count; i++) {
        if (buf.readUInt16BE(offset + 10 + i * 2) !== 0) out.add(first + i);
      }
    } else if (format === 12) {
      const nGroups = buf.readUInt32BE(offset + 12);
      for (let g = 0; g < nGroups; g++) {
        const rec = offset + 16 + g * 12;
        const start = buf.readUInt32BE(rec);
        const end = buf.readUInt32BE(rec + 4);
        // Guard against pathological ranges in broken fonts.
        for (let c = start; c <= end && c - start < 0x10000; c++) out.add(c);
      }
    }
  }
  return out;
}

/** The bold sibling of a face. */
export function boldOf(face: FaceName): FaceName {
  return face.endsWith("-bold") ? face : (`${face}-bold` as FaceName);
}

/**
 * Pick the face that can actually draw `char`, preferring the requested
 * family. Returns null when no embedded face covers the character — callers
 * must then substitute visibly rather than silently dropping it.
 */
export function faceForChar(char: string, family: FontFamily, weight: FontWeight): FaceName | null {
  const cp = char.codePointAt(0) ?? 0;
  const bold = weight === "bold";
  const primary: FaceName[] = isBengali(char)
    ? bold
      ? ["bengali-bold", "bengali", "sans-bold", "sans"]
      : ["bengali", "bengali-bold", "sans", "sans-bold"]
    : family === "mono"
      ? bold
        ? ["mono-bold", "mono", "sans-bold", "sans", "bengali-bold", "bengali"]
        : ["mono", "mono-bold", "sans", "sans-bold", "bengali", "bengali-bold"]
      : bold
        ? ["sans-bold", "sans", "mono-bold", "mono", "bengali-bold", "bengali"]
        : ["sans", "sans-bold", "mono", "mono-bold", "bengali", "bengali-bold"];

  for (const face of primary) {
    if (faceSupports(face, cp)) return face;
  }
  return null;
}
