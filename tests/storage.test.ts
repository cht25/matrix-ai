import { describe, expect, it } from "vitest";
import { sniffMime, readDimensions, validateImageUpload } from "../src/lib/ai/upload-validation";

// Tiny valid PNG (1x1 red pixel).
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1 height=1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

// Minimal JPEG (SOI + APP0 + DQT + SOF0 with 100x64 dims + EOI), with
// internally consistent segment lengths so the parser walks the markers.
const JPEG = Uint8Array.from([
  0xff, 0xd8, // SOI
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0 (len 0x10)
  0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // DQT (len 0x04 → 2 payload bytes)
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x64, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0: height 0x0040, width 0x0064
  0xff, 0xd9, // EOI
]);

// Executable (MZ header).
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

describe("File validation (spec §14, §43)", () => {
  it("sniffs PNG/JPEG by magic bytes", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
  });

  it("rejects executables and unknown types", () => {
    expect(sniffMime(EXE)).toBeNull();
  });

  it("reads PNG dimensions", () => {
    expect(readDimensions(PNG, "image/png")).toEqual({ width: 1, height: 1 });
  });

  it("reads JPEG dimensions from SOF markers", () => {
    expect(readDimensions(JPEG, "image/jpeg")).toEqual({ width: 100, height: 64 });
  });

  it("rejects tiny images (dimension floor)", () => {
    const check = validateImageUpload(PNG, null);
    expect(check.ok).toBe(false);
    expect(check.error).toBe("DIMENSIONS_INVALID");
  });

  it("rejects MIME mismatch between client claim and magic bytes", () => {
    const big = new Uint8Array(PNG.length + 100);
    big.set(PNG);
    // Fake a large PNG by padding? Dimension check would fail anyway;
    // instead test the MIME mismatch path directly with a valid dims image.
    const wide = new Uint8Array([...PNG.slice(0, 16), 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x40, ...PNG.slice(24)]);
    const check = validateImageUpload(wide, "image/jpeg");
    expect(check.ok).toBe(false);
    expect(check.error).toBe("MIME_MISMATCH");
  });

  it("accepts a valid large-enough PNG", () => {
    const wide = new Uint8Array([...PNG.slice(0, 16), 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x40, ...PNG.slice(24)]);
    const check = validateImageUpload(wide, "image/png");
    expect(check.ok).toBe(true);
    expect(check.mime).toBe("image/png");
    expect(check.width).toBe(64);
    expect(check.height).toBe(64);
  });
});
