// Shared path matching for the edge middleware and tests.
// Keep this free of Node-only / Admin SDK imports — it is bundled for Edge.

/** Routes anyone may hit without a session cookie. `/` is exact-only. */
export const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify",
  "/docs",
  "/privacy",
  "/terms",
  "/support",
  "/emergency",
  // Certificate verification, the print view and the PDF all expose exactly
  // the same public-safe fields (name, course, score, date, ID) — no email,
  // phone, DOB or address — so all three are reachable without a session.
  "/certificate/verify",
  "/certificate/print",
  "/api/certificate",
  "/scams",
  "/api/health",
  "/api/ai",
  "/s",
] as const;

/** Auth screens — signed-in visitors are bounced to /chat. */
export const AUTH_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"] as const;

/**
 * Prefix match that treats `/` as exact and every other entry as
 * `path === entry || path.startsWith(entry + "/")`.
 *
 * Never use `path.startsWith("/")` — that would mark every URL public.
 */
export function pathMatches(path: string, entry: string): boolean {
  const clean = path.split("?")[0] || "/";
  if (entry === "/") return clean === "/";
  return clean === entry || clean.startsWith(`${entry}/`);
}

export function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => pathMatches(path, p));
}

export function isAuthPage(path: string): boolean {
  return AUTH_PATHS.some((p) => pathMatches(path, p));
}

/**
 * Build a same-origin Location value (path + query only).
 * Relative Locations keep the browser on the host it already requested —
 * critical behind Cloudflare / Render, where an absolute `new URL(..., request.url)`
 * can pick up a different Host (e.g. an unbound apex) and 404 there.
 */
/**
 * Where to send a user after a successful sign-in.
 * Profile details are edited in Settings — never forced as a first-login wizard.
 */
export function postAuthDestination(next?: string | null): string {
  if (
    typeof next === "string" &&
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.startsWith("/login") &&
    !next.startsWith("/register") &&
    next !== "/onboarding" &&
    !next.startsWith("/onboarding/")
  ) {
    return next;
  }
  return "/chat";
}

export function internalLocation(pathname: string, search?: Record<string, string>): string {
  // Collapse any leading slashes so "//evil.example/login" cannot become a
  // protocol-relative Location (which the browser would treat as another host).
  const path = `/${(pathname.split("?")[0] || "/").replace(/^\/+/, "")}`;
  const params = new URLSearchParams(search);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
