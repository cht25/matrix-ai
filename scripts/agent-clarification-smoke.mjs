#!/usr/bin/env node
// Development-preview integration check only: mocked /api/ai, not a production
// provider. Run against `next dev` with browser-safe dummy Firebase web config.
import assert from 'node:assert/strict';
import { chromium as playwright } from 'playwright-core';
import chromium, { inflate } from '@sparticuz/chromium';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform === 'linux' && !process.env.AWS_EXECUTION_ENV) {
  const packageDir = dirname(createRequire(import.meta.url).resolve('@sparticuz/chromium'));
  const libraries = await inflate(join(packageDir, '../bin/al2023.tar.br'));
  process.env.LD_LIBRARY_PATH = [join(libraries, 'lib'), join(tmpdir(), 'swiftshader'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}
const browser = await playwright.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  let buildRequests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/build') buildRequests++; });
  await page.goto(`${process.env.BROWSER_BASE_URL || 'http://127.0.0.1:3000'}/dev-preview/chat?mode=agent`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Agent · clarification first' }).click();
  try {
    await page.getByText('What is the primary purpose or main message of the website?').waitFor({ timeout: 15_000 });
  } catch (error) {
    console.error('Observed viewport:', (await page.locator('body').innerText()).slice(-2600), 'build requests:', buildRequests, 'page errors:', errors);
    throw error;
  }
  assert.equal(buildRequests, 0, 'clarification must not POST /api/build');
  assert.equal(await page.getByText('Build failed', { exact: false }).count(), 0, 'no false failure card');
  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log('agent clarification: question rendered, no build request, no failure card, no browser exceptions');
} finally {
  await browser.close();
}
