#!/usr/bin/env node
// =============================================================================
// QORVYNA native-shell smoke test.
//
// Verifies the Tauri shell's render path with a REAL browser at phone and
// desktop viewports: the shared login screen, no Facebook button, no
// horizontal overflow, and the bundled static frontend loading.
//
//   node scripts/smoke-native.mjs                  # against next dev on :3000
//   TARGET=file://…/public/native/index.html node scripts/smoke-native.mjs
// =============================================================================
import { chromium } from "playwright-core";
import { chromiumExecutable } from "./lib/chromium-path.mjs";
import { existsSync } from "node:fs";

const executablePath = await chromiumExecutable();
if (!executablePath) {
  console.log("SKIP: no Chromium binary available in this environment");
  process.exit(0);
}

const target = process.env.TARGET ?? "http://127.0.0.1:3000/native-app";
const bundle = existsSync("public/native/app.js");
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

for (const [name, viewport] of [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1360, height: 860 }],
]) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 200)}`);
  });
  const response = await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 }).catch((error) => {
    console.log(`FAIL  ${name}: navigation failed — ${error.message}`);
    failures += 1;
    return null;
  });
  if (!response) continue;
  const html = await page.content();
  const body = await page.evaluate(() => document.body.innerText);
  console.log(`\n[${name}] ${target} → ${response.status()}`);
  check(`${name}: HTTP 200`, response.status() === 200, String(response.status()));
  check(`${name}: brand rendered`, /QORVYNA/i.test(body));
  check(`${name}: no Facebook sign-in`, !/facebook/i.test(html));
  check(`${name}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check(`${name}: no uncaught errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  if (name === "desktop") console.log(`      body: ${body.replace(/\s+/g, " ").slice(0, 120)}`);
  await page.close();
}

check("native bundle exists (public/native/app.js)", bundle);
check("native bundle ships the real design system (app.css)", existsSync("public/native/app.css"));
check("native bundle has an index.html", existsSync("public/native/index.html"));

await browser.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
