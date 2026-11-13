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
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
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
