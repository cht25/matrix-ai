import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/seo";

// =============================================================================
// MATRIX robots.txt — served by Next.js at /robots.txt.
//
// Points crawlers at the sitemap and keeps authenticated / private surfaces
// out of the index. The public pages (homepage, docs, courses, scam library,
// legal/help pages and the auth screens) stay crawlable by default.
//
// Disallow patterns mirror the middleware's public/private split in
// src/lib/routing.ts — anything not in PUBLIC_PATHS bounces logged-out
// visitors to /login, so it must not be indexed.
// =============================================================================

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: [
          // Administration (RBAC-gated).
          "/admin/",
          // Backend / RPC / AI endpoints.
          "/api/",
          // Sandboxed project previews (short links).
          "/s/",
          // Authenticated app surfaces.
          "/chat",
          "/dashboard",
          "/history",
          "/projects",
          "/scanner",
          "/security",
          "/settings",
          "/report",
          "/onboarding",
          "/temporary-chat",
          "/certificates",
          // Certificate verification is for shared links, not search.
          "/certificate/",
        ],
      },
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
    host: siteOrigin(),
  };
}
