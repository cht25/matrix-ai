#!/usr/bin/env node
// =============================================================================
// QORVYNA — native frontend bundler (Tauri)
//
// Produces `public/native/` — a self-contained build of the SHARED frontend
// (src/native/client/entry.tsx, which mounts the website's own components).
// Tauri's `frontendDist` points at this folder, so the installed app ships its
// own assets instead of loading https://… as its primary screen.
//
// The bundle talks to the QORVYNA backend over HTTPS, exactly like the website:
// it is a static bundle, not a server. `QORVYNA_API_ORIGIN` (or NEXT_PUBLIC_APP_URL)
// tells it where the API lives; every call is origin-qualified at build time.
//
// Usage:
//   node scripts/native/build-native-frontend.mjs            # production bundle
//   node scripts/native/build-native-frontend.mjs --check    # verify only
// =============================================================================

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "public", "native");
const checkOnly = process.argv.includes("--check");

const API_ORIGIN = (process.env.QORVYNA_API_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "https://qorvyna.thamjj13.top").replace(/\/+$/, "");
const APP_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(message) {
  console.error(`\n[native] ${message}\n`);
  process.exit(1);
}

if (!existsSync(join(root, "node_modules", "esbuild"))) {
  if (checkOnly) fail("esbuild is not installed; run `npm ci` before building the native frontend.");
  fail("esbuild is not installed. Run `npm ci` (esbuild is a devDependency of the native bundle).");
}

console.log(`[native] bundling the shared QORVYNA frontend`);
console.log(`[native] API origin: ${API_ORIGIN}`);
console.log(`[native] version:    ${APP_VERSION}`);

/**
 * `--check` used to only verify that esbuild was installed, which meant a stale
 * bundle (code changed, `public/native` never rebuilt) passed silently. It now
 * fails when any bundled source is newer than the output, or when a source file
 * the bundle imports does not exist in the output at all.
 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

if (checkOnly) {
  const bundlePath = join(outDir, "app.js");
  const cssPath = join(outDir, "app.css");
  if (!existsSync(bundlePath) || !existsSync(cssPath)) {
    fail("public/native is missing its bundle. Run `node scripts/native/build-native-frontend.mjs`.");
  }
  const builtAt = Math.min(statSync(bundlePath).mtimeMs, statSync(cssPath).mtimeMs);
  const sources = ["src", "scripts/native"].map((dir) => newestMtime(join(root, dir)));
  const newestSource = Math.max(...sources);
  if (newestSource > builtAt) {
    const drift = Math.round((newestSource - builtAt) / 1000);
    fail(
      `public/native is STALE: source changed ${drift}s after the last build.\n` +
        `  Rebuild with: node scripts/native/build-native-frontend.mjs\n` +
        `  (a native build would otherwise ship the old frontend)`,
    );
  }
  console.log(`[native] --check: bundle is current (${Math.round((builtAt - newestSource) / 1000)}s ahead of sources).`);
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// The shared app references assets by absolute path (/brand/…); copy them so
// the app looks identical inside the webview.
const publicAssets = ["brand", "favicon.ico", "icon-192.png", "icon-512.png", "site.webmanifest", "sw.js"];
for (const asset of publicAssets) {
  const from = join(root, "public", asset);
  if (!existsSync(from)) continue;
  cpSync(from, join(outDir, asset), { recursive: true, dereference: true });
}

/**
 * The stylesheet. `src/app/globals.css` starts with `@import "tailwindcss"` and
 * the design-system layers — that is a Tailwind v4 entry, so it is compiled by
 * Tailwind's own CLI over the same source files the website uses. The result
 * is hashed to give both the webview <link> and the offline precache the same
 * immutable name.
 */
let cssName = "app.css";
try {
  const cssOut = join(outDir, "app.css");
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["@tailwindcss/cli", "--input", "src/app/globals.css", "--output", cssOut, "--minify"],
    { cwd: root, stdio: "inherit" },
  );
  const css = readFileSync(cssOut);
  if (!css.length) throw new Error("Tailwind produced an empty stylesheet");
  console.log(`[native] stylesheet: ${(css.length / 1024).toFixed(0)} kB from src/app/globals.css`);
} catch (error) {
  fail(`stylesheet build failed: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "esbuild",
      "src/native/client/entry.tsx",
      "--bundle",
      "--format=esm",
      "--platform=browser",
      "--target=chrome110,safari15",
      `--outfile=${join(outDir, "app.js")}`,
      "--jsx=automatic",
      "--loader:.tsx=tsx",
      "--loader:.ttf=file",
      "--loader:.woff=file",
      "--loader:.woff2=file",
      "--loader:.svg=dataurl",
      "--alias:@=./src",
      "--define:process.env.NODE_ENV=\"production\"",
      "--define:process.env.NEXT_PUBLIC_QORVYNA_NATIVE=\"1\"",
      "--log-level=warning",
      "--minify",
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
  );
} catch (error) {
  fail(`esbuild failed: ${error instanceof Error ? error.message : String(error)}`);
}

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html lang="en" data-qorvyna-native="1">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>QORVYNA AI</title>
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <meta name="qorvyna-api-origin" content="${API_ORIGIN}" />
    <meta name="qorvyna-version" content="${APP_VERSION}" />
    <link rel="stylesheet" href="./${cssName}" />
  </head>
  <body class="bg-bg text-ink">
    <div id="qorvyna-root" class="min-h-dvh"></div>
    <noscript>QORVYNA needs JavaScript in this app view.</noscript>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`,
);

console.log(`[native] wrote ${outDir}`);
