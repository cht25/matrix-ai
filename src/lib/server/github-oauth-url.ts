import "server-only";
import { createHmac } from "node:crypto";
import { siteOrigin } from "@/lib/seo";

export class GithubOAuthConfigError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** The OAuth origin is an operator setting, never a Host/X-Forwarded-Host
 * supplied by the browser or an internal upstream port. */
export function githubOAuthUrls(requestUrl: string): { origin: string; callback: string } {
  const production = process.env.NODE_ENV === "production";
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  let origin: string;
  if (!production) {
    const request = new URL(requestUrl);
    // Local development is the sole exception. Never trust arbitrary request
    // hosts (including forwarded headers) as an OAuth redirect authority.
    if (["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)) {
      origin = request.origin;
    } else {
      origin = configuredOrigin(configured);
    }
  } else {
    origin = configuredOrigin(configured);
  }
  const callback = `${origin}/api/github/callback`;
  const override = (process.env.GITHUB_OAUTH_CALLBACK_URL ?? "").trim();
  if (override && override !== callback) throw new GithubOAuthConfigError("GITHUB_CALLBACK_URL_MISMATCH");
  return { origin, callback };
}

function configuredOrigin(value: string): string {
  if (!value) throw new GithubOAuthConfigError("GITHUB_APP_URL_MISSING");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        url.origin !== siteOrigin() || (url.port && url.port !== "443")) {
      throw new GithubOAuthConfigError("GITHUB_APP_URL_INVALID");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof GithubOAuthConfigError) throw error;
    throw new GithubOAuthConfigError("GITHUB_APP_URL_INVALID");
  }
}

/** Only an owned chat page can be restored; never accept protocol-relative or
 * external destinations from the OAuth start URL or a forged cookie. */
export function githubReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/chat?mode=agent";
  try {
    const url = new URL(value, "https://matrix.invalid");
    if (url.origin !== "https://matrix.invalid" || !/^\/chat(?:\/[a-zA-Z0-9_-]{1,128})?$/.test(url.pathname)) return "/chat?mode=agent";
    return `${url.pathname}?mode=agent`;
  } catch { return "/chat?mode=agent"; }
}

export function githubResultPath(returnPath: string, status: string): string {
  const url = new URL(githubReturnPath(returnPath), "https://matrix.invalid");
  url.searchParams.set("github", status);
  return `${url.pathname}${url.search}`;
}

/** Bind the state cookie to the signed-in MATRIX user. The key never enters
 * the browser; a session swap during the ten-minute OAuth roundtrip fails. */
export function githubOwnerBinding(state: string, uid: string, key: string): string {
  return createHmac("sha256", key).update(`${state}:${uid}`).digest("base64url");
}
