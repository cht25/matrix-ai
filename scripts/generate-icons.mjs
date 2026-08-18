// =============================================================================
// MATRIX icon generation — renders the compact MATRIX mark to favicon files.
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

// Standalone mark (fixed colors — no CSS variables for maximum compatibility).
const MARK = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7aa2ff"/>
      <stop offset="1" stop-color="#2f5fe0"/>
    </linearGradient>
  </defs>
  <rect width="48" height="48" rx="11" fill="#070a12"/>
  <path d="M24 5 40 11v10.5c0 9.6-6.8 16.6-16 20.5-9.2-3.9-16-10.9-16-20.5V11l16-6Z" fill="none" stroke="url(#g)" stroke-width="2.4" stroke-linejoin="round"/>
  <circle cx="17" cy="18" r="2" fill="#7aa2ff"/>
  <circle cx="24" cy="14" r="2" fill="#9aa6bf"/>
  <circle cx="31" cy="18" r="2" fill="#7aa2ff"/>
  <circle cx="24" cy="24" r="2.5" fill="#7aa2ff"/>
  <circle cx="17" cy="30" r="2" fill="#9aa6bf"/>
  <circle cx="31" cy="30" r="2" fill="#9aa6bf"/>
  <path d="M17 18h14M24 14v10m-7 6 7-6m7 6-7-6" stroke="#7aa2ff" stroke-width="1.3" stroke-linecap="round" opacity="0.8"/>
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

  // ICO container with embedded PNGs (16 + 32).
  const ico16 = pngs["favicon-16x16.png"];
  const ico32 = pngs["favicon-32x32.png"];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(2, 2); // count
  const entries = [
    { w: 16, h: 16, size: 0, offset: 6 + 16, data: ico16 },
    { w: 32, h: 32, size: 0, offset: 6 + 16 + 16, data: ico32 },
  ];
  const entryBuf = Buffer.alloc(32);
  entries.forEach((e, i) => {
    entryBuf.writeUInt8(e.w, i * 16);
    entryBuf.writeUInt8(e.h, i * 16 + 1);
    entryBuf.writeUInt8(0, i * 16 + 2); // palette
    entryBuf.writeUInt8(0, i * 16 + 3); // reserved
    entryBuf.writeUInt16LE(1, i * 16 + 4); // planes
    entryBuf.writeUInt16LE(32, i * 16 + 6); // bpp
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
