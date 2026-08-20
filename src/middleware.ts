import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/firebase/session-shared";
import { internalLocation, isAuthPage, isPublic } from "@/lib/routing";

// Edge-runtime routing guard.
//
// Firebase session cookies are JWTs, but the Admin SDK needed to verify
// their signature cannot run in Next.js middleware (edge runtime). So this
// middleware only performs an UNVERIFIED presence/expiry decode of the
// cookie payload for routing UX — every server component and API route
// re-verifies the signature with the Admin SDK before trusting anything.
//
// Redirects stay on the requester's own origin. `internalLocation()` yields a
// same-origin path (`/login?...`); it is resolved against the incoming
// request's URL only to satisfy Next's middleware adapter, which requires a
// parseable URL in `Location` (a bare relative path throws `Invalid URL` and
// turns every guarded page into a 500 for logged-out visitors under
// `next start`). Because the base is the URL the visitor actually requested,
// the redirect can never hop to a differently-configured host (Render primary
// domain, `NEXT_PUBLIC_APP_URL` apex, …) the way hardcoded absolute URLs did.

type JwtPayload = { exp?: number; role?: string; admin?: boolean; email_verified?: boolean };

/** Cheap base64url decode of the JWT payload — NO signature verification. */
function decodePayload(jwt: string): JwtPayload | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as JwtPayload;
  } catch {
    return null;
  }
}

/** 307 that keeps the visitor on the origin they requested. */
function bounce(request: NextRequest, pathname: string, search?: Record<string, string>): NextResponse {
  // internalLocation() collapses "//host/…" so the path part can never smuggle
  // in another origin; new URL(path, request.nextUrl) then pins the redirect
  // to the host/protocol the visitor is already on.
  return NextResponse.redirect(new URL(internalLocation(pathname, search), request.nextUrl), 307);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const payload = cookie ? decodePayload(cookie) : null;
  const valid = payload?.exp != null && payload.exp > Date.now() / 1000;

  // Signed in with a live session cookie → auth pages bounce to the app.
  if (valid && isAuthPage(pathname)) {
    return bounce(request, "/chat");
  }

  if (!valid && !isPublic(pathname)) {
    return bounce(request, "/login", { next: pathname });
  }

  // Admin routes need an admin role. Unverified here (UX only) — the admin
  // layout re-checks authoritatively with the Admin SDK.
  if (valid && pathname.startsWith("/admin") && pathname !== "/admin/setup" && !payload?.role && !payload?.admin) {
    return bounce(request, "/chat");
  }

  const res = NextResponse.next();
  res.headers.set("x-matrix-pathname", pathname);
  return res;
}

export const config = {
  // API routes handle their own authentication (JSON 401s) — the middleware
  // only guards page routing. Static assets in public/ must be excluded or
  // the browser gets a login-page redirect instead of the file: the manifest
  // fetch follows redirects, so /site.webmanifest → /login produced
  // "Manifest: Line 1, column 1, Syntax error" on logged-out sessions.
  // `.html` is excluded too: Google Search Console fetches its verification
  // file (public/google….html) logged out — a 307 to /login fails the check.
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest|json|txt|xml|html|woff2?)$).*)",
  ],
};
