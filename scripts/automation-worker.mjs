#!/usr/bin/env node
import { isIP } from 'node:net';
// Deploy as a separate always-on worker. It never executes model-generated code.
const secret = process.env.AUTOMATION_WORKER_SECRET?.trim();
if (!secret || secret.length < 32) {
  console.error('AUTOMATION_WORKER_SECRET must contain at least 32 characters.');
  process.exit(1);
}
const targetInput = process.env.MATRIX_WORKER_TARGET_URL?.trim();
if (!targetInput) {
  console.error('MATRIX_WORKER_TARGET_URL must be set to the deployed MATRIX application URL.');
  process.exit(1);
}
const targetOrigin = new URL(targetInput);
function isPrivateHost(input) {
  const rawHost = input.toLowerCase().replaceAll('[', '').replaceAll(']', '');
  const host = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) return !host.startsWith('2') && !host.startsWith('3');
  return false;
}
const developmentHttp = process.env.NODE_ENV === 'development' && targetOrigin.protocol === 'http:' && isPrivateHost(targetOrigin.hostname);
if (targetOrigin.username || targetOrigin.password || targetOrigin.search || targetOrigin.hash || isPrivateHost(targetOrigin.hostname) && !developmentHttp || (targetOrigin.protocol !== 'https:' && !developmentHttp)) {
  console.error('MATRIX_WORKER_TARGET_URL must be a valid HTTPS origin (HTTP localhost is development-only).');
  process.exit(1);
}
const target = new URL('/api/jobs/automations', targetOrigin.origin);
const interval = Math.max(10_000, Number(process.env.AUTOMATION_POLL_MS) || 30_000);
let stopped = false;
let timer;
process.on('SIGTERM', () => { stopped = true; clearTimeout(timer); });
process.on('SIGINT', () => { stopped = true; clearTimeout(timer); });
async function tick() {
  try {
    const response = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 10 }), signal: AbortSignal.timeout(120_000), redirect: 'error' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
    console.log(JSON.stringify({ event: 'automation_batch', at: new Date().toISOString(), attempted: body.attempted, succeeded: body.succeeded }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'automation_batch_failed', at: new Date().toISOString(), code: error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') : 'UNKNOWN' }));
  }
  if (!stopped) timer = setTimeout(tick, interval);
}
console.log(JSON.stringify({ event: 'automation_worker_started', interval, target: target.origin }));
await tick();
