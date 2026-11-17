import "server-only";
import { brandEnv } from "@/lib/brand-env";

/**
 * CSRF boundary for cookie-authenticated mutations. Native clients may omit
 * Origin, but must present a verified bearer token (checked by the route).
 * A browser's Origin/Sec-Fetch-Site is never supplied by our JSON client from
 * an untrusted value. Forwarded headers are trusted only behind an explicitly
 * configured proxy that overwrites them.
 *
 * ORIGIN ALLOWLIST — domain-migration notes
 * ----------------------------------------
 * A deployment must list every origin its browser actually uses, otherwise the
 * session exchange (`POST /api/auth/session`) answers 403 BAD_ORIGIN *after*
 * Google has already signed the user in — which is indistinguishable from
 * "Google is broken" unless it is labelled correctly (it now is: see
 * src/lib/auth/oauth.ts).
 *
 * Sources, in order:
 *   1. the origin this request was addressed to (`request.url`) — the plain
 *      same-origin case;
 *   2. `NEXT_PUBLIC_APP_URL` — the deployment's canonical public origin;
 *   3. `QORVYNA_ALLOWED_ORIGINS` (legacy: `MATRIX_ALLOWED_ORIGINS`) — a
 *      comma-separated list of extra EXACT origins, e.g. a www host or a
 *      previous domain that still serves the app during a migration;
 *   4. `X-Forwarded-Host`/`-Proto` ONLY when `QORVYNA_TRUST_PROXY_HEADERS=true`.
 *
 * Entries are matched as exact origins (scheme + host + port). The list can
 * never be widened by a request header unless the proxy is explicitly trusted,
 * and a malformed value never disables the check.
 */

function firstHeaderValue(value: string | null): string {
  return (value ?? "").split(",")[0]?.trim() ?? "";
}

/** Parse a configured origin; anything that is not a bare http(s) origin is ignored. */
function configuredOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    // Reject paths/queries/credentials: an allowlist entry is an origin.
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Extra origins from `QORVYNA_ALLOWED_ORIGINS` / `MATRIX_ALLOWED_ORIGINS`. */
export function extraAllowedOrigins(): string[] {
  const raw = brandEnv("ALLOWED_ORIGINS") ?? "";
  return raw
    .split(/[,\s]+/)
    .map(configuredOrigin)
    .filter((origin): origin is string => Boolean(origin));
}

/** The exact origins this deployment accepts for browser mutations. */
export function allowedMutationOrigins(request: Request): string[] {
  const allowed = new Set<string>();
  try {
    const reqUrl = new URL(request.url);
    allowed.add(reqUrl.origin);
    // When bound to wildcard 0.0.0.0 locally, Node/Next reports 0.0.0.0 in
    // request.url while browsers address loopback (localhost / 127.0.0.1).
    if (reqUrl.hostname === "0.0.0.0") {
      const portSuffix = reqUrl.port ? `:${reqUrl.port}` : "";
      allowed.add(`${reqUrl.protocol}//127.0.0.1${portSuffix}`);
      allowed.add(`${reqUrl.protocol}//localhost${portSuffix}`);
    }
  } catch {
    /* unparseable request URL: fall through to configuration only */
  }
  const fromConfig = configuredOrigin(process.env.NEXT_PUBLIC_APP_URL ?? "");
  if (fromConfig) allowed.add(fromConfig);
  for (const origin of extraAllowedOrigins()) allowed.add(origin);

  if (brandEnv("TRUST_PROXY_HEADERS") === "true") {
    const host = firstHeaderValue(request.headers.get("x-forwarded-host"));
    const protocol = firstHeaderValue(request.headers.get("x-forwarded-proto"));
    if (host && /^[a-z0-9.:-]+$/i.test(host) && (protocol === "https" || protocol === "http")) {
      allowed.add(`${protocol}://${host}`);
    }
  }
  return [...allowed];
}

export function mutationOriginAllowed(request: Request): boolean {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  if (!unsafe) return true;
  const bearer = /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "");
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;
  if (!origin || origin === "null") return bearer;

  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) return false;
    if (!["https:", "http:"].includes(parsed.protocol)) return false;
    return allowedMutationOrigins(request).includes(origin);
  } catch {
    return false;
  }
}

export function mutationCsrfResponse(request: Request): Response | null {
  if (mutationOriginAllowed(request)) return null;
  return Response.json(
    {
      success: false,
      error: {
        code: "BAD_ORIGIN",
        // Deployment hostnames only — no credentials, no user data.
        message: `Origin ${request.headers.get("origin") ?? "(missing)"} is not allowed for this deployment. Allowed: ${allowedMutationOrigins(request).join(", ") || "(none configured)"}.`,
      },
      data: null,
    },
    { status: 403 },
  );
}
