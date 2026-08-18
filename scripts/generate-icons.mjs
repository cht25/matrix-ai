// =============================================================================
// MATRIX icon generation — monochrome monogram M on near-black.
//   node scripts/generate-icons.mjs
// Outputs to public/: favicon.ico, favicon-16x16.png, favicon-32x32.png,
// apple-touch-icon.png, icon-192.png, icon-512.png
// =============================================================================

import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public");
mkdirSync(outDir, { recursive: true });

const MARK = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <rect width="40" height="40" rx="8" fill="#0b0d10"/>
  <circle cx="20" cy="20" r="14.5" fill="none" stroke="#e9ebee" stroke-width="1.1" opacity="0.5"/>
  <path d="M14.5 27 V13 L20 21.5 L25.5 13 V27" fill="none" stroke="#e9ebee" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const svgBuffer = Buffer.from(MARK);

async function main() {
  const sizes = [
    { name: "favicon-16x16.png", size: 16 },
    { name: "favicon-32x32.png", size: 32 },
    { name: "apple-touch-icon.png", size: 180 },
    { name: "icon-192.png", size: 192 },
    { name: "icon-512.png", size: 512 },
  ];

  const pngs = {};
  for (const s of sizes) {
    const png = await sharp(svgBuffer).resize(s.size, s.size).png().toBuffer();
    pngs[s.name] = png;
    writeFileSync(join(outDir, s.name), png);
    console.log("✓", s.name, `(${s.size}x${s.size}, ${png.length} bytes)`);
  }

  const ico16 = pngs["favicon-16x16.png"];
  const ico32 = pngs["favicon-32x32.png"];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(2, 2);
  const entries = [
    { w: 16, h: 16, data: ico16, offset: 6 + 32 },
    { w: 32, h: 32, data: ico32, offset: 6 + 32 + 16 },
  ];
  const entryBuf = Buffer.alloc(32);
  entries.forEach((e, i) => {
    entryBuf.writeUInt8(e.w, i * 16);
    entryBuf.writeUInt8(e.h, i * 16 + 1);
    entryBuf.writeUInt8(0, i * 16 + 2);
    entryBuf.writeUInt8(0, i * 16 + 3);
    entryBuf.writeUInt16LE(1, i * 16 + 4);
    entryBuf.writeUInt16LE(32, i * 16 + 6);
    entryBuf.writeUInt32LE(e.data.length, i * 16 + 8);
    entryBuf.writeUInt32LE(e.offset, i * 16 + 12);
  });
  const ico = Buffer.concat([header, entryBuf, ico16, ico32]);
  writeFileSync(join(outDir, "favicon.ico"), ico);
  console.log("✓ favicon.ico", `(${ico.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
