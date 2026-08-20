// =============================================================================
// Canonical origin for SEO artifacts (`/sitemap.xml`, `/robots.txt`).
//
// Production is served from the host baked into `NEXT_PUBLIC_APP_URL`
// (see .env.example, apphosting.yaml and render.yaml). When that value is
// missing — or still points at localhost, e.g. an unconfigured dev box —
// we fall back to the public apex so generated SEO files never ship
// `http://localhost:3000` URLs to search engines.
//
// This module must stay free of Node-only / Admin SDK imports (it is also
// consumed by the sitemap/robots route handlers, which are simple builds).
// =============================================================================

export const PRODUCTION_ORIGIN = "https://thamjj13.top";

export function siteOrigin(): string {
  const candidate = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  const usable =
    candidate.length > 0 &&
    /^https?:\/\//i.test(candidate) &&
    !/^https?:\/\/localhost(:\d+)?$/i.test(candidate);

  return (usable ? candidate : PRODUCTION_ORIGIN).replace(/\/+$/, "");
}
