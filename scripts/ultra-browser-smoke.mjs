#!/usr/bin/env node
// Test-only Chromium integration against the existing development ChatClient
// preview. Provider/STT/storage responses are intercepted: NOT live E2E.
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
const base = process.env.BROWSER_BASE_URL || 'http://127.0.0.1:3000';
const pcm = Buffer.alloc(32000);
const wav = Buffer.alloc(44 + pcm.length);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
    const browser = await playwright.launch({ executablePath: await chromium.executablePath(), headless: true,
      args: [...chromium.args, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    try {
    const context = await browser.newContext({ viewport, permissions: ['microphone'], reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let uploads = 0;
    await page.route('**/api/voice/transcribe', async route => {
      uploads++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        transcript: 'বাংলা English sample', audio_asset_id: '12345678-1234-1234-1234-123456789abc',
        playback_url: '/api/voice/audio/12345678-1234-1234-1234-123456789abc', detected_language: 'bn',
      }) });
    });
    await page.route('**/api/voice/audio/**', async route => route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }));
    await page.goto(`${base}/dev-preview/chat`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Record a voice message' }).waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal overflow');
    await page.getByRole('button', { name: 'Record a voice message' }).click();
    await page.getByRole('group', { name: 'Voice recording composer' }).waitFor();
    assert.equal(await page.locator('canvas[aria-label="Live microphone waveform"]').evaluate(c => c.width > 0), true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('group', { name: 'Voice recording composer' }).waitFor({ state: 'hidden' });
    assert.equal(uploads, 0, 'cancel must never upload');
    await page.getByRole('button', { name: 'Record a voice message' }).click();
    await page.getByRole('group', { name: 'Voice recording composer' }).waitFor();
    await page.waitForTimeout(1150);
    assert.match(await page.getByRole('group', { name: 'Voice recording composer' }).innerText(), /0:0[1-9]/);
    await page.getByRole('button', { name: 'Stop and send voice message' }).click();
    await page.getByRole('group', { name: 'Voice recording composer' }).waitFor({ state: 'hidden' });
    await page.getByLabel('Voice message').first().waitFor({ timeout: 30_000 });
    assert.equal(uploads, 1, 'stop must upload automatically exactly once');
    assert.equal(await page.getByRole('button', { name: 'Play voice message' }).count(), 1);
    await page.getByRole('button', { name: 'Play voice message' }).click();
    await page.getByRole('button', { name: 'Pause voice message' }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Pause voice message' }).click();
    await page.getByText('Transcript · bn').click();
    await page.getByText('বাংলা English sample').first().waitFor();
    await page.locator('textarea[aria-label="Message MATRIX"]').waitFor();
    // Existing dev-only gateway streams small real SSE frames (a mock provider,
    // never a replay of a completed production response).
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'hidden', timeout: 20_000 });
    await page.getByRole('button', { name: 'Long response · scroll stress' }).click();
    await page.getByText('Section 2', { exact: false }).first().waitFor({ timeout: 20_000 });
    const viewportNode = page.locator('.chat-viewport');
    await viewportNode.evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 })); node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
    try { await page.getByRole('button', { name: 'Scroll to new content' }).waitFor({ timeout: 2500 }); }
    catch {
      await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'hidden', timeout: 20_000 });
      await page.getByRole('button', { name: '1 · hi' }).click();
      await page.getByRole('button', { name: 'Scroll to new content' }).waitFor({ timeout: 10_000 });
    }
    const previousScroll = await viewportNode.evaluate(node => node.scrollTop);
    await page.waitForTimeout(300);
    assert.ok(Math.abs((await viewportNode.evaluate(node => node.scrollTop)) - previousScroll) < 5, 'scroll stays pinned while reading earlier content');
    await page.getByRole('button', { name: 'Scroll to new content' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'stable layout');
    assert.deepEqual(errors, [], `browser exceptions: ${errors}`);
    console.log(`${viewport.name}: voice/cancel/timer/waveform/auto-send/bubble/transcript and SSE scroll follow/pause passed (mocked providers)`);
    await context.close();
    } finally { await browser.close(); }
  }
