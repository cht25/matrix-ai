// =============================================================================
// Canonical origin for SEO artifacts (`/sitemap.xml`, `/robots.txt`) AND all
// public URL generation (published sites, deployment links, canonical URLs).
//
// SINGLE SOURCE OF TRUTH for the production base URL:
//   • If NEXT_PUBLIC_APP_URL is set to a real https:// URL, use it.
//   • Otherwise fall back to the hardcoded production origin so generated
//     URLs never ship `http://localhost:3000` or a bare *.onrender.com domain
//     to search engines, public pages or published sites.
//
// The canonical production domain is https://matrix.thamjj13.top.
// =============================================================================

export const PRODUCTION_ORIGIN = "https://matrix.thamjj13.top";

/**
 * Returns the authoritative base origin for all public URLs.
 * Safe to call in server and edge contexts. Never returns localhost.
 */
export function siteOrigin(): string {
  const candidate = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  const usable =
    candidate.length > 0 &&
    /^https?:\/\//i.test(candidate) &&
    !/^https?:\/\/localhost(:\d+)?$/i.test(candidate) &&
    !/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(candidate) &&
    !/^https?:\/\/0\.0\.0\.0(:\d+)?$/i.test(candidate);

  return (usable ? candidate : PRODUCTION_ORIGIN).replace(/\/+$/, "");
}
