import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next otherwise synthesizes an absolute 308 for /s/<slug>/ from the
  // internal upstream origin (often localhost:10000 behind a TLS proxy).
  // Public-site canonicalization is handled by the route using relative Location.
  skipTrailingSlashRedirect: true,
  eslint: { ignoreDuringBuilds: true },
  // Allow the Arena / e2b preview host to load the dev server.
  allowedDevOrigins: ["*.e2b.app"],
  experimental: {
    serverActions: { bodySizeLimit: "8mb" },
  },
  // Firebase's web-auth helper is normally served by
  // <projectId>.firebaseapp.com. When a deployment deliberately sets
  // NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN to its own hostname (see
  // docs/AUTH_DOMAIN_MIGRATION.md), these rewrites make /__/auth/* reach the
  // reverse proxy in src/app/api/auth/firebase-handler. With the default
  // Firebase-hosted authDomain nothing requests these paths.
  //
  // NOTE: App Router folders starting with "_" are private, so the public
  // /__/auth path cannot be a route folder itself — hence the rewrite.
  async rewrites() {
    return [
      { source: "/__/auth/:path*", destination: "/api/auth/firebase-handler/:path*" },
      { source: "/__/auth", destination: "/api/auth/firebase-handler" },
    ];
  },
  // PDFKit is a CommonJS/Node library with its own binary assets; bundling it
  // breaks its `fs` reads. Keep it external on the server.
  serverExternalPackages: ["pdfkit"],
  // The PDF engine reads its embedded Unicode fonts from disk at runtime, so
  // they must be traced into the deployment output.
  outputFileTracingIncludes: {
    "/api/**/*": ["./src/lib/pdf/fonts/**"],
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
