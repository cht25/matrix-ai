// =============================================================================
// Firebase Auth helper reverse proxy — the origin that serves `/__/auth/*`
//
// PUBLIC URLS: /__/auth/* (rewritten here by next.config.ts). This file lives
// under /api/ because Next.js treats any route folder starting with "_" as a
// private folder, so `app/__/auth/route.ts` would never be routed.
//
// WHY THIS EXISTS
// Firebase's web sign-in (popup or redirect) is completed by a helper page that
// Firebase serves at `https://<authDomain>/__/auth/handler`. By default
// authDomain is `<projectId>.firebaseapp.com`, which Google always serves and
// always authorizes — that is the recommended setup for an app that is NOT
// hosted on Firebase Hosting (QORVYNA runs on a Node host such as Render / App
// Hosting).
//
// Some deployments must keep the helper on the site's own origin instead
// (blocked third-party storage, a strict Content-Service-Policy, or a corporate
// proxy that forbids the extra origin). Firebase documents that as a reverse
// proxy: forward `/__/auth/*` to `<projectId>.firebaseapp.com/__/auth/*`.
// That is exactly what this route does — so setting
// `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=qorvyna.thamjj13.top` results in a handler
// that is genuinely served at that host instead of a dead URL.
//
// It is INERT unless the configured authDomain is a custom (non-Firebase)
// hostname: with the default `*.firebaseapp.com` authDomain nothing ever
// requests this route and it answers 404. Changing the authDomain string alone
// would break sign-in; this route (plus the rewrite in next.config.ts) is the
// other half of that configuration.
// =============================================================================

import { NextResponse, type NextRequest } from "next/server";
import { firebaseAuthProxyUrl } from "@/lib/firebase/web-config";
import { firebaseAuthUsesSameOriginHandler, firebaseProjectId } from "@/lib/env-public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never forwarded to the upstream handler. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
]);

/**
 * Never relayed back to the browser. `accept-encoding: identity` means fetch has
 * already decoded the body, so the upstream encoding headers would corrupt it.
 * X-Frame-Options / CSP are dropped because the handler is deliberately loaded
 * same-origin (including in the auth iframe) — the proxy exists to make that
 * work, and the upstream page is Firebase's own, unmodified.
 */
const DROP_FROM_UPSTREAM = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "alt-svc",
]);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

type Context = { params: Promise<{ path?: string[] }> };

async function proxy(request: NextRequest, context: Context): Promise<Response> {
  if (!firebaseAuthUsesSameOriginHandler) {
    return new NextResponse("Not found", { status: 404 });
  }
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return new NextResponse("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });
  }

  const { path = [] } = await context.params;
  const target = firebaseAuthProxyUrl(firebaseProjectId, path, request.nextUrl.search);
  if (!target) {
    return new NextResponse("Firebase project is not configured", { status: 503 });
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("accept-encoding", "identity");

  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // The upstream host is Firebase's; a failure here is a deployment/network
    // problem, never something the visitor did.
    console.error(`[QORVYNA] Firebase auth proxy failed for ${target}`, err);
    return new NextResponse("Firebase authentication is temporarily unreachable.", { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_FROM_UPSTREAM.has(key.toLowerCase())) out.set(key, value);
  });
  const leaf = path[path.length - 1] ?? "handler";
  if (path.length === 0 || leaf === "handler" || leaf === "iframe") {
    out.set("cache-control", "private, no-store, no-cache, must-revalidate");
  }
  // The handler sets short-lived auth cookies; forward every one of them.
  const setCookies =
    typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  for (const cookie of setCookies) out.append("set-cookie", cookie);

  return new NextResponse(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

export async function GET(request: NextRequest, context: Context) {
  return proxy(request, context);
}

export async function HEAD(request: NextRequest, context: Context) {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: Context) {
  return proxy(request, context);
}
