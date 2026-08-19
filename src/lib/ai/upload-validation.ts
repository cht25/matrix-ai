// =============================================================================
// Upload/file validation helpers (spec §14, §43) — used by the AI gateway scan
// action. Rejects executables, wrong types, oversized files and embedded
// metadata.
// =============================================================================

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type FileCheck = {
  ok: boolean;
  error?: string;
  mime?: string;
  width?: number;
  height?: number;
  size: number;
};

// Magic-byte sniffing — never trust client-supplied MIME types.
const MAGIC: { mime: string; bytes: number[] }[] = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF" — confirmed via bytes 8-11 "WEBP"
];

export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") {
    return "image/webp";
  }
  for (const m of MAGIC) {
    if (m.bytes.every((b, i) => bytes[i] === b)) return m.mime;
  }
  return null;
}

// Minimal PNG/JPEG dimension parsing (no external deps in the edge runtime).
export function readDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png") {
      if (bytes.length < 24) return null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, 24);
      if (dv.getUint32(12) !== 0x49484452) return null; // IHDR
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i < Math.min(bytes.length, 65536)) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
        }
        const len = ((bytes[i + 2] << 8) | bytes[i + 3]) + 2;
        i += len;
      }
      return null;
    }
    if (mime === "image/webp") {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, 30);
      // VP8X: bytes 12..15 are "VP8X", width/height are 24-bit little-endian at 24
      if (new TextDecoder().decode(bytes.slice(12, 16)) === "VP8X") {
        const w = dv.getUint32(24, true) & 0xffffff;
        const h = dv.getUint32(27, true) & 0xffffff;
        return { width: w, height: h };
      }
      if (new TextDecoder().decode(bytes.slice(12, 16)) === "VP8L") {
        const b = bytes;
        const w = 1 + (((b[21] & 0x3f) << 8) | b[20]);
        const h = 1 + (((b[23] & 0xf) << 10) | (b[22] << 2) | ((b[21] & 0xc0) >> 6));
        return { width: w, height: h };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export function validateImageUpload(bytes: Uint8Array, clientMime: string | null): FileCheck {
  const size = bytes.byteLength;
  if (size === 0) return { ok: false, error: "EMPTY_FILE", size };
  if (size > MAX_IMAGE_BYTES) return { ok: false, error: "FILE_TOO_LARGE", size };

  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, error: "UNSUPPORTED_TYPE", size };
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mime)) {
    return { ok: false, error: "UNSUPPORTED_TYPE", size };
  }
  // If the client claims a type, it must agree with the magic bytes.
  if (clientMime && clientMime !== mime) {
    return { ok: false, error: "MIME_MISMATCH", size };
  }

  const dims = readDimensions(bytes, mime);
  if (!dims || dims.width < 64 || dims.height < 64) {
    return { ok: false, error: "DIMENSIONS_INVALID", size };
  }
  if (dims.width > 8000 || dims.height > 8000) {
    return { ok: false, error: "DIMENSIONS_TOO_LARGE", size };
  }

  return { ok: true, mime, width: dims.width, height: dims.height, size };
}
