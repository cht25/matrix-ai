#!/usr/bin/env node
// Deploy as a separate always-on worker. It never executes model-generated code.
const secret = process.env.AUTOMATION_WORKER_SECRET?.trim();
if (!secret || secret.length < 32) {
  console.error('AUTOMATION_WORKER_SECRET must contain at least 32 characters.');
  process.exit(1);
}
const target = new URL('/api/jobs/automations', process.env.MATRIX_WORKER_TARGET_URL || 'http://127.0.0.1:3000');
if (!['https:', 'http:'].includes(target.protocol)) throw new Error('Invalid worker target');
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
