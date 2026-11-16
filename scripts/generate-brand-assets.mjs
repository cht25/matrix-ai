#!/usr/bin/env node
// =============================================================================
// QORVYNA brand asset generator.
//
//   node scripts/generate-brand-assets.mjs
//
// One run rebuilds, from scripts/brand/geometry.mjs:
//   · src/lib/brand-geometry.json      shapes used by the in-app <Logo>
//   · public/brand/*.svg               logo system (stacked, horizontal,
//                                      compact, wordmark, emblem, monochrome)
//   · public/brand/*.png|webp          social preview, email header, splash
//   · public/*                         favicons, touch icon, PWA icons
//   · src-tauri/icons/*                Windows / desktop icons
//   · mobile/**/mipmap-*/ic_launcher   Android + Wear OS launcher icons
//
// Only dependency: sharp (already a devDependency). No fonts are required:
// the wordmark is geometry and the tagline is drawn with a system sans stack.
// =============================================================================

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { EMBLEM, EMBLEM_SMALL, PALETTE, WORDMARK } from "./brand/geometry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (...parts) => path.join(root, ...parts);
const TAGLINE = "ONE INTELLIGENCE. INFINITE POSSIBILITIES.";
const PILLARS = ["AI", "Agents", "IoT", "Robotics", "Automation", "Cloud", "Developers"];

// Text in the logo files is converted to outlines from the Inter files the app
// already ships (@fontsource/inter), so a logo looks the same in every viewer
// whether or not Inter is installed. fontkit comes with pdfkit.
const require = createRequire(import.meta.url);
const fontkit = createRequire(require.resolve("pdfkit"))("fontkit");
const interFile = (weight) => out("node_modules/@fontsource/inter/files", `inter-latin-${weight}-normal.woff`);
const INTER = { 500: fontkit.create(await fs.readFile(interFile(500))), 600: fontkit.create(await fs.readFile(interFile(600))) };

/** Outline `text` at (x, y = baseline). Returns the path data and its width. */
function outline(text, { weight = 600, size, tracking = 0, x = 0, y = 0, anchor = "start" }) {
  const font = INTER[weight];
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  const advances = run.positions.map((position) => position.xAdvance * scale + tracking);
  const width = advances.reduce((sum, advance) => sum + advance, 0) - tracking;
  let cursor = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  let d = "";
  run.glyphs.forEach((glyph, index) => {
    d += glyph.path.scale(scale, -scale).translate(cursor, y).toSVG();
    cursor += advances[index];
  });
  return { d, width };
}

// --- SVG fragments -----------------------------------------------------------
let uid = 0;

/** Full emblem markup for a 512-unit box. `mono` draws it in one flat colour. */
function emblem({ mono = null } = {}) {
  const id = `e${uid++}`;
  const { ringPath, tailPath, orbitPath, orbitTransform, orbit, body } = EMBLEM;
  const paint = (gradient) => (mono ? mono : `url(#${id}-${gradient})`);
  // The two halves overlap by a hair so no seam shows where they meet.
  const far = `<clipPath id="${id}-far"><rect x="-300" y="-140" width="600" height="141.5"/></clipPath>`;
  const near = `<clipPath id="${id}-near"><rect x="-300" y="0" width="600" height="140"/></clipPath>`;
  const nearWide = `<clipPath id="${id}-nearw"><rect x="-300" y="-7" width="600" height="160"/></clipPath>`;
  return `<defs>
    <linearGradient id="${id}-ring" gradientUnits="userSpaceOnUse" x1="318" y1="108" x2="150" y2="420">
      <stop offset="0" stop-color="${PALETTE.cyan}"/><stop offset=".46" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.violet}"/>
    </linearGradient>
    <linearGradient id="${id}-tail" gradientUnits="userSpaceOnUse" x1="222" y1="262" x2="430" y2="398">
      <stop offset="0" stop-color="${PALETTE.cyan}"/><stop offset=".55" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.blueDeep}"/>
    </linearGradient>
    <linearGradient id="${id}-orbit" gradientUnits="userSpaceOnUse" x1="${-orbit.outer.rx}" y1="0" x2="${orbit.outer.rx}" y2="0">
      <stop offset="0" stop-color="${PALETTE.cyan}"/><stop offset=".5" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.violetBright}"/>
    </linearGradient>
    <radialGradient id="${id}-body" cx=".36" cy=".32" r=".75">
      <stop offset="0" stop-color="#D6F3FF"/><stop offset=".42" stop-color="#3FA2FF"/><stop offset="1" stop-color="${PALETTE.blueDeep}"/>
    </radialGradient>
    <radialGradient id="${id}-halo">
      <stop offset="0" stop-color="#5FB4FF" stop-opacity=".55"/><stop offset="1" stop-color="#5FB4FF" stop-opacity="0"/>
    </radialGradient>
    ${far}${near}${nearWide}
    <mask id="${id}-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <rect width="512" height="512" fill="#fff"/>
      <g transform="${orbitTransform}" clip-path="url(#${id}-nearw)"><path d="${orbitPath}" fill-rule="evenodd" fill="#000" stroke="#000" stroke-width="12"/></g>
    </mask>
    <clipPath id="${id}-behind"><path clip-rule="evenodd" d="M0 0H512V512H0Z${EMBLEM.behindPath}"/></clipPath>
    <mask id="${id}-ringcut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <rect width="512" height="512" fill="#fff"/>
      <path d="${tailPath}" fill="#000" stroke="#000" stroke-width="15" stroke-linejoin="miter"/>
      <g transform="${orbitTransform}" clip-path="url(#${id}-nearw)"><path d="${orbitPath}" fill-rule="evenodd" fill="#000" stroke="#000" stroke-width="13"/></g>
    </mask>
  </defs>
  <g clip-path="url(#${id}-behind)"><g transform="${orbitTransform}" clip-path="url(#${id}-far)"><path d="${orbitPath}" fill-rule="evenodd" fill="${paint("orbit")}"/></g></g>
  <path d="${ringPath}" fill-rule="evenodd" fill="${paint("ring")}" mask="url(#${id}-ringcut)"/>
  <path d="${tailPath}" fill="${paint("tail")}" mask="url(#${id}-cut)"/>
  <g transform="${orbitTransform}" clip-path="url(#${id}-near)"><path d="${orbitPath}" fill-rule="evenodd" fill="${paint("orbit")}"/></g>
  ${mono ? "" : `<circle cx="${body.cx}" cy="${body.cy}" r="${body.halo}" fill="url(#${id}-halo)"/>`}
  <circle cx="${body.cx}" cy="${body.cy}" r="${body.r}" fill="${mono ? mono : `url(#${id}-body)`}"/>`;
}

/** Heavier, orbit-free emblem for very small sizes. */
function emblemSmall({ mono = null } = {}) {
  const id = `s${uid++}`;
  const { ringPath, tailPath, body } = EMBLEM_SMALL;
  return `<defs>
    <linearGradient id="${id}-ring" gradientUnits="userSpaceOnUse" x1="330" y1="92" x2="110" y2="470">
      <stop offset="0" stop-color="${PALETTE.cyan}"/><stop offset=".46" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.violet}"/>
    </linearGradient>
    <linearGradient id="${id}-tail" gradientUnits="userSpaceOnUse" x1="200" y1="282" x2="470" y2="470">
      <stop offset="0" stop-color="${PALETTE.cyan}"/><stop offset="1" stop-color="${PALETTE.blueDeep}"/>
    </linearGradient>
    <mask id="${id}-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <rect width="512" height="512" fill="#fff"/>
      <path d="${tailPath}" fill="#000" stroke="#000" stroke-width="34" stroke-linejoin="miter"/>
    </mask>
  </defs>
  <path d="${ringPath}" fill-rule="evenodd" fill="${mono ?? `url(#${id}-ring)`}" mask="url(#${id}-cut)"/>
  <path d="${tailPath}" fill="${mono ?? `url(#${id}-tail)`}"/>
  <circle cx="${body.cx}" cy="${body.cy}" r="${body.r}" fill="${mono ?? PALETTE.cyan}"/>`;
}

/** Wordmark markup in its own coordinate system (width × 100). */
function wordmark({ ink, mono = false }) {
  const id = `w${uid++}`;
  const { width, height, qBowl, qTailGap, accent } = WORDMARK;
  const accentPaint = mono ? ink : `url(#${id}-accent)`;
  return `<defs>
    <linearGradient id="${id}-accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${PALETTE.cyan}"/><stop offset="1" stop-color="${PALETTE.blue}"/>
    </linearGradient>
    <mask id="${id}-q" maskUnits="userSpaceOnUse" x="-20" y="-20" width="${width + 40}" height="${height + 40}">
      <rect x="-20" y="-20" width="${width + 40}" height="${height + 40}" fill="#fff"/><path d="${qTailGap}" fill="#000"/>
    </mask>
  </defs>
  <path d="${qBowl}" fill-rule="evenodd" fill="${ink}" mask="url(#${id}-q)"/>
  ${WORDMARK.ink.map((d) => `<path d="${d}" fill-rule="evenodd" fill="${ink}"/>`).join("")}
  ${accent.map((d) => `<path d="${d}" fill="${accentPaint}"/>`).join("")}`;
}

const n = (value) => Number(value.toFixed(2));
const svg = (width, height, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="QORVYNA"${extra}><title>QORVYNA</title>${body}</svg>\n`;
const place = (x, y, scale, body) => `<g transform="translate(${x} ${y}) scale(${scale})">${body}</g>`;

function taglineRule(cx, y, width, ink, size = 15) {
  const text = outline(TAGLINE, { weight: 600, size, tracking: size * 0.34, x: cx, y, anchor: "middle" });
  const gap = size * 1.5;
  const half = width / 2;
  const rule = (from, to, id) => `<rect x="${n(from)}" y="${n(y - size * 0.36 - 1)}" width="${n(to - from)}" height="2" rx="1" fill="url(#${id})"/>`;
  const id = `r${uid++}`;
  return `<defs>
    <linearGradient id="${id}-a" x1="0" x2="1"><stop offset="0" stop-color="${PALETTE.cyan}"/><stop offset="1" stop-color="${PALETTE.violet}"/></linearGradient>
    <linearGradient id="${id}-b" x1="0" x2="1"><stop offset="0" stop-color="${PALETTE.blue}"/><stop offset="1" stop-color="${PALETTE.violet}"/></linearGradient>
  </defs>
  ${rule(cx - half, cx - text.width / 2 - gap, `${id}-a`)}${rule(cx + text.width / 2 + gap, cx + half, `${id}-b`)}
  <path d="${text.d}" fill="${ink}"/>`;
}

// --- Logo compositions ---------------------------------------------------------
const THEMES = {
  dark: { ink: PALETTE.white, muted: "#9FB0D0" }, // for dark backgrounds
  light: { ink: PALETTE.ink, muted: "#475569" }, // for light backgrounds
};

function stacked(theme, { tagline = true, mono = false } = {}) {
  const t = THEMES[theme];
  const wmScale = 0.56;
  const wmWidth = WORDMARK.width * wmScale;
  const width = 680;
  const height = tagline ? 468 : 404;
  return svg(width, height, [
    place((width - 300) / 2, 4, 300 / 512, emblem({ mono: mono ? t.ink : null })),
    place((width - wmWidth) / 2, 318, wmScale, wordmark({ ink: t.ink, mono })),
    tagline ? taglineRule(width / 2, 438, 648, t.muted, 12.5) : "",
  ].join(""));
}

function horizontal(theme, { mono = false } = {}) {
  const t = THEMES[theme];
  const wmScale = 0.5;
  const width = Math.round(132 + 18 + WORDMARK.width * wmScale + 8);
  return svg(width, 132, [
    place(0, 0, 132 / 512, emblem({ mono: mono ? t.ink : null })),
    place(150, 44, wmScale, wordmark({ ink: t.ink, mono })),
  ].join(""));
}

function wordmarkOnly(theme, { mono = false } = {}) {
  const t = THEMES[theme];
  return svg(WORDMARK.width, WORDMARK.height, wordmark({ ink: t.ink, mono }));
}

function emblemOnly({ mono = null, small = false } = {}) {
  return svg(512, 512, small ? emblemSmall({ mono }) : emblem({ mono }));
}

/** App icon: the emblem on a deep-navy tile. `bleed` fills the square (maskable). */
function appIcon({ bleed = false, small = false } = {}) {
  // Maskable icons keep the mark inside the central safe zone launchers crop to.
  const inset = bleed ? 86 : small ? 58 : 40;
  const size = 512 - inset * 2;
  return svg(512, 512, `<defs>
      <radialGradient id="tile" cx=".3" cy=".18" r="1.05"><stop offset="0" stop-color="#16225A"/><stop offset=".55" stop-color="${PALETTE.navyRaised}"/><stop offset="1" stop-color="${PALETTE.navy}"/></radialGradient>
    </defs>
    <rect width="512" height="512" rx="${bleed ? 0 : 112}" fill="url(#tile)"/>
    ${place(inset, inset, size / 512, small ? emblemSmall() : emblem())}`);
}

function socialPreview() {
  const width = 1200, height = 630;
  const wmScale = 0.74;
  const wmWidth = WORDMARK.width * wmScale;
  // Lay the ecosystem labels out from their real widths so the dividers sit
  // exactly between neighbours.
  const pad = 30;
  const labels = PILLARS.map((label) => ({ label, width: outline(label, { weight: 500, size: 23 }).width }));
  const rowWidth = labels.reduce((sum, item) => sum + item.width, 0) + pad * 2 * (labels.length - 1);
  let cursor = (width - rowWidth) / 2;
  const pillarPaths = [];
  const dividers = [];
  labels.forEach((item, index) => {
    pillarPaths.push(outline(item.label, { weight: 500, size: 23, x: cursor, y: 566 }).d);
    cursor += item.width;
    if (index < labels.length - 1) dividers.push(`<rect x="${n(cursor + pad - 0.75)}" y="544" width="1.5" height="28" fill="#2A3A6B"/>`);
    cursor += pad * 2;
  });
  return svg(width, height, `<defs>
      <radialGradient id="bg" cx=".5" cy=".3" r=".9"><stop offset="0" stop-color="#101B4D"/><stop offset=".5" stop-color="${PALETTE.navyRaised}"/><stop offset="1" stop-color="#04060F"/></radialGradient>
      <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${PALETTE.blue}" stop-opacity=".34"/><stop offset="1" stop-color="${PALETTE.blue}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <ellipse cx="600" cy="210" rx="430" ry="240" fill="url(#glow)"/>
    ${place((width - 300) / 2, 38, 300 / 512, emblem())}
    ${place((width - wmWidth) / 2, 356, wmScale, wordmark({ ink: PALETTE.white }))}
    ${taglineRule(width / 2, 492, 1060, "#A9B8D8", 20)}
    <path d="${pillarPaths.join("")}" fill="#8FA3CC"/>
    ${dividers.join("")}`);
}

function emailHeader() {
  const wmScale = 0.4;
  const width = 600, height = 120;
  const lockupWidth = 76 + 14 + WORDMARK.width * wmScale;
  const left = (width - lockupWidth) / 2;
  return svg(width, height, `<rect width="${width}" height="${height}" fill="${PALETTE.navy}"/>
    ${place(left, 22, 76 / 512, emblem())}
    ${place(left + 90, 40, wmScale, wordmark({ ink: PALETTE.white }))}`);
}

function splash() {
  const size = 1024;
  const wmScale = 0.62;
  return svg(size, size, `<rect width="${size}" height="${size}" fill="${PALETTE.navy}"/>
    ${place((size - 380) / 2, 250, 380 / 512, emblem())}
    ${place((size - WORDMARK.width * wmScale) / 2, 668, wmScale, wordmark({ ink: PALETTE.white }))}`);
}

// --- Raster helpers ------------------------------------------------------------
const png = (markup, size, extra = {}) => sharp(Buffer.from(markup), { density: 300 }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, ...extra }).png({ compressionLevel: 9 }).toBuffer();
const pngBox = (markup, width, height) => sharp(Buffer.from(markup), { density: 200 }).resize(width, height, { fit: "fill" }).png({ compressionLevel: 9 }).toBuffer();

/** Windows .ico: classic 32-bit DIB entries up to 64 px, PNG for 256 px. */
async function ico(markupFor, sizes) {
  const entries = [];
  for (const size of sizes) {
    const source = markupFor(size);
    if (size >= 256) {
      entries.push({ size, data: await png(source, size) });
      continue;
    }
    const { data } = await sharp(Buffer.from(source), { density: 300 }).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(size * size * 4, 20);
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const from = ((size - 1 - y) * size + x) * 4; // DIB rows are bottom-up
        const to = (y * size + x) * 4;
        pixels[to] = data[from + 2]; pixels[to + 1] = data[from + 1]; pixels[to + 2] = data[from]; pixels[to + 3] = data[from + 3];
      }
    }
    const maskRow = Math.ceil(size / 32) * 4;
    entries.push({ size, data: Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]) });
  }
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0); directory.writeUInt16LE(1, 2); directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8); directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return path.relative(root, file);
}

// --- Build ---------------------------------------------------------------------
const written = [];
const save = async (file, data) => written.push(await write(file, data));

// 1. Geometry consumed by the React <Logo>.
await save(out("src/lib/brand-geometry.json"), `${JSON.stringify({
  emblem: { size: EMBLEM.size, ringPath: EMBLEM.ringPath, behindPath: EMBLEM.behindPath, tailPath: EMBLEM.tailPath, orbitPath: EMBLEM.orbitPath, orbitTransform: EMBLEM.orbitTransform, orbitRx: EMBLEM.orbit.outer.rx, body: EMBLEM.body },
  emblemSmall: { size: EMBLEM_SMALL.size, ringPath: EMBLEM_SMALL.ringPath, tailPath: EMBLEM_SMALL.tailPath, body: EMBLEM_SMALL.body },
  wordmark: WORDMARK,
  palette: PALETTE,
}, null, 2)}\n`);

// 2. Scalable logo system.
const brand = (name) => out("public/brand", name);
const vectors = {
  "qorvyna-logo-dark.svg": stacked("dark"),
  "qorvyna-logo-light.svg": stacked("light"),
  "qorvyna-compact-dark.svg": stacked("dark", { tagline: false }),
  "qorvyna-compact-light.svg": stacked("light", { tagline: false }),
  "qorvyna-horizontal-dark.svg": horizontal("dark"),
  "qorvyna-horizontal-light.svg": horizontal("light"),
  "qorvyna-wordmark-dark.svg": wordmarkOnly("dark"),
  "qorvyna-wordmark-light.svg": wordmarkOnly("light"),
  "qorvyna-emblem.svg": emblemOnly(),
  "qorvyna-emblem-small.svg": emblemOnly({ small: true }),
  "qorvyna-mono-white.svg": stacked("dark", { tagline: false, mono: true }),
  "qorvyna-mono-black.svg": stacked("light", { tagline: false, mono: true }),
  "qorvyna-emblem-mono-white.svg": emblemOnly({ mono: PALETTE.white }),
  "qorvyna-emblem-mono-black.svg": emblemOnly({ mono: PALETTE.ink }),
  "qorvyna-app-icon.svg": appIcon(),
};
for (const [name, markup] of Object.entries(vectors)) await save(brand(name), markup);

// 3. Raster brand assets.
await save(brand("qorvyna-social-preview.png"), await pngBox(socialPreview(), 1200, 630));
await save(brand("qorvyna-social-preview.webp"), await sharp(Buffer.from(socialPreview()), { density: 200 }).resize(1200, 630).webp({ quality: 90 }).toBuffer());
await save(brand("qorvyna-email-header.png"), await pngBox(emailHeader(), 1200, 240));
await save(brand("qorvyna-splash.png"), await png(splash(), 1024));
await save(brand("qorvyna-logo-dark.png"), await sharp(Buffer.from(stacked("dark")), { density: 300 }).resize(1280).png({ compressionLevel: 9 }).toBuffer());
await save(brand("qorvyna-logo-light.png"), await sharp(Buffer.from(stacked("light")), { density: 300 }).resize(1280).png({ compressionLevel: 9 }).toBuffer());
await save(brand("qorvyna-emblem.png"), await png(emblemOnly(), 1024));
await save(brand("qorvyna-emblem.webp"), await sharp(Buffer.from(emblemOnly()), { density: 300 }).resize(512, 512).webp({ quality: 92 }).toBuffer());

// 4. Web favicons, touch icon and PWA icons. Tiny sizes use the heavier mark.
const faviconFor = (size) => emblemOnly({ small: size <= 48 });
await save(out("public/favicon.svg"), emblemOnly({ small: true }));
await save(out("public/favicon.ico"), await ico(faviconFor, [16, 32, 48]));
await save(out("public/favicon-16x16.png"), await png(faviconFor(16), 16));
await save(out("public/favicon-32x32.png"), await png(faviconFor(32), 32));
await save(out("public/favicon-48x48.png"), await png(faviconFor(48), 48));
await save(out("public/apple-touch-icon.png"), await sharp(Buffer.from(appIcon({ bleed: true })), { density: 300 }).resize(180, 180).flatten({ background: PALETTE.navy }).png().toBuffer());
await save(out("public/icon-192.png"), await png(appIcon(), 192));
await save(out("public/icon-512.png"), await png(appIcon(), 512));
await save(out("public/icon-maskable-192.png"), await png(appIcon({ bleed: true }), 192));
await save(out("public/icon-maskable-512.png"), await png(appIcon({ bleed: true }), 512));

// 5. Desktop (Tauri / Windows).
const desktopIcon = (size) => appIcon({ small: size <= 48 });
await save(out("src-tauri/icons/32x32.png"), await png(desktopIcon(32), 32));
await save(out("src-tauri/icons/128x128.png"), await png(desktopIcon(128), 128));
await save(out("src-tauri/icons/128x128@2x.png"), await png(desktopIcon(256), 256));
await save(out("src-tauri/icons/icon.png"), await png(desktopIcon(512), 512));
await save(out("src-tauri/icons/icon.ico"), await ico(desktopIcon, [16, 24, 32, 48, 64, 256]));

// 6. Android phone + Wear OS launcher icons.
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(densities)) {
  const icon = await png(appIcon({ small: size <= 48 }), size);
  await save(out(`mobile/matrix_app/android/app/src/main/res/mipmap-${density}/ic_launcher.png`), icon);
  await save(out(`mobile/matrix_wear/android/app/src/main/res/mipmap-${density}/ic_launcher.png`), icon);
}

console.log(`QORVYNA brand assets: ${written.length} files\n` + written.map((file) => `  ${file}`).join("\n"));
