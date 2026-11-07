#!/usr/bin/env node
// Real Chromium checks against a running production build. No API interception,
// fake authentication, demo accounts, or mocked database responses.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium as playwright } from 'playwright-core';
import chromium, { inflate } from '@sparticuz/chromium';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// The bundled Linux runtime also works outside AWS; use its own shared libs.
if (process.platform === 'linux' && !process.env.AWS_EXECUTION_ENV) {
  const packageDir = dirname(createRequire(import.meta.url).resolve('@sparticuz/chromium'));
  const libraries = await inflate(join(packageDir, '../bin/al2023.tar.br'));
  process.env.LD_LIBRARY_PATH = [join(libraries, 'lib'), join(tmpdir(), 'swiftshader'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const base = process.env.BROWSER_BASE_URL || 'http://127.0.0.1:3000';
const output = new URL('../artifacts/browser/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await playwright.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const checks = [];
const errors = [];
let firebaseBrowserConfigured = false;
try {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  let currentViewport = 'desktop';
  page.on('pageerror', (error) => errors.push({ viewport: currentViewport, message: error.message }));
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    currentViewport = viewport.name;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    const configured = await page.locator('#email').count() > 0;
    firebaseBrowserConfigured = configured;
    if (configured) {
      await page.locator('#email').fill('browser-check@example.invalid');
      assert.equal(await page.locator('#email').inputValue(), 'browser-check@example.invalid');
      assert.equal(await page.locator('#password').isVisible(), true);
    } else {
      assert.match(await page.locator('body').innerText(), /AI service not configured/);
      assert.equal(await page.getByRole('button', { name: 'Retry' }).isVisible(), true);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'horizontal overflow');
    await page.screenshot({ path: new URL(`login-${viewport.name}.png`, output).pathname, fullPage: true });
    if (configured) {
      await page.getByRole('link', { name: 'Create one', exact: false }).click();
      await page.waitForURL('**/register');
      await page.locator('input[autocomplete="email"]').waitFor();
    } else {
      await page.goto(`${base}/register`, { waitUntil: 'networkidle' });
      assert.match(await page.locator('body').innerText(), /AI service not configured/);
    }
    checks.push(`${viewport.name}: ${configured ? "login inputs and registration navigation" : "honest unconfigured-auth state and retry control"}, responsive layout`);
  }
  await context.close();
  for (const [path, status] of [['/api/models', 401], ['/api/devices', 401]]) {
    const response = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(response.status, status, `${path} must reject unauthenticated requests`);
    checks.push(`${path}: real HTTP ${status}`);
  }
  const csrf = await fetch(`${base}/api/auth/session`, { method: 'DELETE', headers: { Origin: 'https://attacker.example' } });
  assert.equal(csrf.status, 403);
  checks.push('cross-origin session deletion: real HTTP 403');
  const worker = await fetch(`${base}/api/jobs/automations`, { method: 'POST' });
  assert.equal(worker.status, 503);
  assert.equal((await worker.json()).error, 'WORKER_NOT_CONFIGURED');
  checks.push('unconfigured automation worker: explicit HTTP 503, not a fake success');
  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json();
  assert.equal(typeof healthBody.ok, 'boolean');
  checks.push(`health endpoint: HTTP ${health.status}, ok=${healthBody.ok}; local service credentials not supplied`);
  assert.deepEqual(errors, [], 'uncaught browser errors');
  await writeFile(new URL('results.json', output), JSON.stringify({ checkedAt: new Date().toISOString(), base, authenticatedWorkflowsTested: false, firebaseBrowserConfigured, checks, browserErrors: errors }, null, 2));
  console.log(checks.join('\n'));
} finally { await browser.close(); }
