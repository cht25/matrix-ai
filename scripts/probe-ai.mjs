#!/usr/bin/env node
// =============================================================================
// MATRIX AI — production end-to-end probe.
//
// Performs the EXACT request flow a browser performs, against any deployment:
//   1. GET  /api/health                    — service baseline (live probes)
//   2. POST /api/ai {action:"health"}      — per-mode AI gateway status
//   3. Firebase sign-up (anonymous, then email/password fallback)
//   4. POST /api/auth/session              — mint the httpOnly session cookie
//   5. POST /api/ai chat (streaming SSE)   — real Chat-mode AI request
//   6. POST /api/ai chat (non-streaming)   — real AI request
//   7. POST /api/ai chat mode=agent        — real Agent-mode AI request
//
// Prints MATRIX's own JSON/SSE responses, including the REAL error codes the
// browser maps to user-visible messages (AI_PROVIDER_AUTH_FAILED,
// CHAT_STORAGE_UNAVAILABLE, …) plus the X-MATRIX-Request-ID correlation id to
// grep server logs with. Never prints cookies or tokens.
//
// Usage:
//   node scripts/probe-ai.mjs https://matrix.example.com
// Run it from any machine that can reach the deployment (laptop, CI runner,
// the Render/Firebase shell): `bash` on the production host works too.
// =============================================================================

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] || process.env.PROBE_BASE || "").replace(/\/+$/, "");
if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.error("Usage: node scripts/probe-ai.mjs https://your-deployment.example.com");
  process.exit(2);
}
const RUN = randomUUID().slice(0, 8);

function curl(method, path, { body, cookieFile, timeoutMs = 60000 } = {}) {
  const args = ["-sS", "-m", String(Math.ceil(timeoutMs / 1000)), "-X", method, `${BASE}${path}`,
    "-w", "\n__HTTP_STATUS:%{http_code}__CONTENT_TYPE:%{content_type}__"];
  if (body !== undefined) {
    args.push("-H", "Content-Type: application/json");
    args.push("--data-binary", JSON.stringify(body));
  }
  if (cookieFile) args.push("-b", cookieFile, "-c", cookieFile);
  return new Promise((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`curl failed: ${stderr || err.message}`));
      const m = stdout.match(/\n__HTTP_STATUS:(\d+)__CONTENT_TYPE:([^_\s]+)__/);
      resolve({
        status: m ? Number(m[1]) : 0,
        contentType: m ? m[2].trim() : "?",
        text: m ? stdout.slice(0, m.index) : stdout,
      });
    });
  });
}

function log(label, value) {
  console.log(`\n===== ${label} =====`);
  console.log(value);
}

async function main() {
  console.log(`MATRIX production AI probe — target: ${BASE}`);

  const health = await curl("GET", "/api/health", { timeoutMs: 45000 });
  log(`1. GET /api/health -> ${health.status} ${health.contentType}`, health.text.slice(0, 800));

  for (const mode of ["general", "agent"]) {
    const r = await curl("POST", "/api/ai", { body: { action: "health", mode }, timeoutMs: 90000 });
    log(`2. POST /api/ai {action:"health",mode:"${mode}"} -> ${r.status}`, r.text.slice(0, 400));
  }

  // 3. Discover the PUBLIC Firebase web config from the deployed client bundle
  // (NEXT_PUBLIC_* values are public by design) and sign up a throwaway user.
  const html = (await curl("GET", "/", { timeoutMs: 45000 })).text;
  const chunkPaths = [...new Set(html.match(/\/_next\/static\/[^"']+?\.js/g) || [])];
  let webKey = "";
  for (const p of chunkPaths.slice(0, 40)) {
    try {
      const js = (await curl("GET", p, { timeoutMs: 30000 })).text;
      webKey = (js.match(/AIza[0-9A-Za-z_-]{30,}/) || [])[0] || "";
      if (webKey) break;
    } catch { /* ignore */ }
  }
  log("3. Firebase web API key in client bundle", webKey ? `found (public by design, …${webKey.slice(-4)})` : "NOT FOUND");

  let idToken = "";
  if (webKey) {
    const signUp = async (body) => JSON.parse(
      (await curl("POST", `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${webKey}`, { body, timeoutMs: 30000 }).catch(() => ({ text: "{}" }))).text || "{}",
    );
    let parsed = await signUp({ returnSecureToken: true });
    let kind = "anonymous";
    if (!parsed.idToken) {
      const email = `matrix-probe-${RUN}@example.com`;
      parsed = await signUp({ email, password: `Px-${randomUUID().slice(0, 12)}!aA`, returnSecureToken: true });
      kind = `password ${email}`;
    }
    idToken = parsed.idToken || "";
    log("3b. sign-up", idToken ? `ok (${kind})` : `FAILED: ${parsed?.error?.message ?? "network error"}`);
  } else {
    console.log("Sign-up skipped: no web API key found.");
  }

  if (!idToken) {
    console.log("\n===== PROBE INCOMPLETE =====\nCould not obtain a session (sign-up unavailable). Steps 1–2 above still show the gateway/provider status.");
    return;
  }

  const sess = await curl("POST", "/api/auth/session", { body: { idToken }, timeoutMs: 60000 });
  log(`4. POST /api/auth/session -> ${sess.status}`, sess.text.slice(0, 200) || "(empty body)");
  if (sess.status !== 200) {
    console.log("\n===== PROBE INCOMPLETE =====\nSession mint failed — check the deployment's FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.");
    return;
  }

  const chat = await curl("POST", "/api/ai", {
    body: { action: "chat", message: "Reply with exactly: PROBE-OK", is_temporary: true, stream: true, request_id: `probe-${RUN}-chat` },
    cookieFile: `/tmp/matrix-probe-${RUN}.txt`, timeoutMs: 150000,
  });
  log(`5. POST /api/ai chat (streaming, like the browser) -> ${chat.status} ${chat.contentType}`, chat.text.slice(0, 1200));

  const chatPlain = await curl("POST", "/api/ai", {
    body: { action: "chat", message: "Reply with exactly: PROBE-OK", is_temporary: true, request_id: `probe-${RUN}-plain` },
    cookieFile: `/tmp/matrix-probe-${RUN}.txt`, timeoutMs: 150000,
  });
  log(`6. POST /api/ai chat (non-streaming) -> ${chatPlain.status}`, chatPlain.text.slice(0, 800));

  // NOTE: the server treats mode:"agent" as general when is_temporary is true —
  // so the Agent probe must NOT set is_temporary.
  const agent = await curl("POST", "/api/ai", {
    body: { action: "chat", mode: "agent", message: "Reply with exactly: AGENT-OK", request_id: `probe-${RUN}-agent` },
    cookieFile: `/tmp/matrix-probe-${RUN}.txt`, timeoutMs: 240000,
  });
  log(`7. POST /api/ai chat mode=agent -> ${agent.status}`, agent.text.slice(0, 1200));

  console.log("\n===== PROBE COMPLETE =====");
  console.log("Interpretation:");
  console.log("  • HTTP 200 with real reply/reply events → the AI pipeline works end-to-end.");
  console.log("  • {error:\"AI_PROVIDER_AUTH_FAILED\"}      → the configured provider key is invalid.");
  console.log("  • {error:\"AI_GATEWAY_NOT_CONFIGURED\"}    → no provider key/config on the server.");
  console.log("  • {error:\"CHAT_STORAGE_UNAVAILABLE\"}     → Firestore (chat storage) is failing, not the AI.");
  console.log("  • {error:\"AI_PROVIDER_RATE_LIMITED\"}     → provider quota/rate limit.");
  console.log("  • Any error → grep server logs for the event name or the request id from");
  console.log("    the X-MATRIX-Request-ID header; entries are structured JSON, no secrets.");
}

main().catch((e) => {
  console.error("PROBE CRASHED", e);
  process.exit(1);
});
