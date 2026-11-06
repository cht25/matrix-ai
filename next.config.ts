import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // Allow the Arena / e2b preview host to load the dev server.
  allowedDevOrigins: ["*.e2b.app", "*"],
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
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
