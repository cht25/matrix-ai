// =============================================================================
// Canonical origin for SEO artifacts (`/sitemap.xml`, `/robots.txt`) AND all
// public URL generation (published sites, deployment links, canonical URLs).
//
// This value is configuration-driven, never derived from an untrusted Host or
// forwarded header. A malformed, credential-bearing, local/private, or
// production-insecure value falls back to the fixed production origin.
// =============================================================================

export const PRODUCTION_ORIGIN = "https://matrix.thamjj13.top";

function isLocalOrPrivateHostname(input: string): boolean {
  const withoutBrackets = input.toLowerCase().replace("[", "").replace("]", "");
  const host = withoutBrackets.endsWith(".") ? withoutBrackets.slice(0, -1) : withoutBrackets;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "host.docker.internal") return true;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
      host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") || host.startsWith("::ffff:")) return true;
  const parts = host.split(".");
  const ipv4 = parts.length === 4 && parts.every((part) => part.length > 0 && [...part].every((char) => char >= "0" && char <= "9") && Number(part) <= 255);
  if (ipv4) {
    const [a, b] = parts.map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

/**
 * Returns the authoritative base origin for public URLs. `NEXT_PUBLIC_APP_URL`
 * is an explicit deployment setting, not a request Host header. Paths are
 * discarded so callers can safely append `/s/...`, `/family`, etc.
 */
export function siteOrigin(): string {
  const candidate = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  try {
    const url = new URL(candidate);
    const protocolAllowed = url.protocol === "https:" || (process.env.NODE_ENV !== "production" && url.protocol === "http:");
    const host = url.hostname.toLowerCase();
    const valid = protocolAllowed && !url.username && !url.password && !url.search && !url.hash &&
      host.length > 0 && !isLocalOrPrivateHostname(host);
    return valid ? url.origin : PRODUCTION_ORIGIN;
  } catch {
    return PRODUCTION_ORIGIN;
  }
}
