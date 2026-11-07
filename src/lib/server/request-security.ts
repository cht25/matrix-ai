import "server-only";

/**
 * CSRF boundary for cookie-authenticated mutations. Native clients may omit
 * Origin, but must present a verified bearer token (checked by the route).
 * A browser's Origin/Sec-Fetch-Site is never supplied by our JSON client from
 * an untrusted value. Forwarded headers are trusted only behind an explicitly
 * configured proxy that overwrites them.
 */
export function mutationOriginAllowed(request: Request): boolean {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  if (!unsafe) return true;
  const bearer = /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "");
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;
  if (!origin || origin === "null") return bearer;

  const allowed = new Set<string>();
  try { allowed.add(new URL(request.url).origin); } catch { return false; }
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (["https:", "http:"].includes(url.protocol)) allowed.add(url.origin);
    } catch { /* Invalid configuration never widens the allowlist. */ }
  }
  if (process.env.MATRIX_TRUST_PROXY_HEADERS === "true") {
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (host && /^[a-z0-9.:-]+$/i.test(host) && (protocol === "https" || protocol === "http")) {
      allowed.add(`${protocol}://${host}`);
    }
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && allowed.has(origin);
  } catch { return false; }
}

export function mutationCsrfResponse(request: Request): Response | null {
  if (mutationOriginAllowed(request)) return null;
  return Response.json({ success: false, error: { code: "BAD_ORIGIN", message: "BAD_ORIGIN" }, data: null }, { status: 403 });
}
