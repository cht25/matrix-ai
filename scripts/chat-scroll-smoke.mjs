#!/usr/bin/env node
// Run against `next dev` /dev-preview/chat only. This tests real browser layout
// and ChatClient scroll behavior with a DEV-ONLY simulated SSE transport; it
// is NOT an authenticated provider or production Agent execution test.
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
const executablePath = await chromium.executablePath();
const base = process.env.BROWSER_BASE_URL || 'http://127.0.0.1:3000';
for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }, { name: 'narrow', width: 320, height: 720 }].filter((item) => !process.argv[2] || item.name === process.argv[2])) {
    const browser = await playwright.launch({ executablePath, args: chromium.args, headless: true });
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/dev-preview/chat`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.__chatShift = { count: 0, score: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) { window.__chatShift.count++; window.__chatShift.score += entry.value; }
        }
      }).observe({ type: 'layout-shift', buffered: false });
    });
    await page.getByRole('button', { name: 'Long response · scroll stress' }).click();
    const scroll = page.locator('.chat-viewport');
    await page.waitForFunction(() => document.querySelector('.chat-viewport')?.textContent?.includes('Section 8'), { timeout: 20_000 });
    const initial = await scroll.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
    assert(initial.height > initial.client, `${viewport.name}: content must overflow`);
    assert(initial.height - initial.client - initial.top < 180, `${viewport.name}: following should keep the answer in view`);
    // Real wheel input, not a programmatic scrollTop write. Wait until the
    // viewport is far enough from the bottom to prove follow was suspended.
    const box = await scroll.boundingBox();
    assert(box, `${viewport.name}: scrollport exists`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const beforeWheel = await scroll.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, -2600);
    await page.waitForTimeout(100);
    const readingTop = await scroll.evaluate((el) => el.scrollTop);
    assert(readingTop < beforeWheel, `${viewport.name}: wheel should scroll upward (before=${beforeWheel}, after=${readingTop})`);
    await page.evaluate(() => { window.__chatShift = { count: 0, score: 0 }; });
    await page.waitForTimeout(450);
    const manualShift = await page.evaluate(() => window.__chatShift);
    const heldTop = await scroll.evaluate((el) => el.scrollTop);
    assert(Math.abs(heldTop - readingTop) < 10, `${viewport.name}: background chunks moved the reader (${heldTop - readingTop}px)`);
    await page.getByRole('button', { name: 'Scroll to new content' }).click();
    await page.waitForTimeout(250);
    const resumed = await scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    assert(resumed < 120, `${viewport.name}: explicit follow must resume (distance=${resumed})`);
    await page.waitForFunction(() => document.querySelector('.chat-viewport')?.textContent?.includes('Section 65'), { timeout: 30_000 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, `${viewport.name}: horizontal page overflow`);
    const composer = page.locator('textarea').first();
    const originalComposer = await composer.boundingBox();
    assert(originalComposer && originalComposer.y + originalComposer.height <= viewport.height + 2, `${viewport.name}: composer initially visible ${JSON.stringify(originalComposer)}`);
    await page.setViewportSize({ width: viewport.width, height: Math.max(490, viewport.height - 250) });
    await page.waitForTimeout(100);
    const resizedComposer = await composer.boundingBox();
    assert(resizedComposer && resizedComposer.y + resizedComposer.height <= Math.max(490, viewport.height - 250) + 2, `${viewport.name}: composer visible after keyboard-like resize ${JSON.stringify(resizedComposer)}`);
    assert.deepEqual(errors, [], `${viewport.name}: browser exceptions`);
    const shift = await page.evaluate(() => window.__chatShift);
    console.log(`${viewport.name}: progressive response, scroll pause/resume, composer resize, no overflow; total layout-shift score=${shift.score.toFixed(4)} (${shift.count} entries), while reading=${manualShift.score.toFixed(4)} (${manualShift.count} entries)`);
    await page.close();
    await browser.close();
  }

