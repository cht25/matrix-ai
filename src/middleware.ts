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
// Redirects are always *relative* (`Location: /login?...`). Absolute
// redirects built from `request.url` inherit whatever Host the proxy
// forwarded (Render primary domain, Cloudflare apex rewrite, …). If that
// host is not bound to this service the browser lands on a plain-text
// "Not Found" — which is Render's default, not this app's 404 page.

type JwtPayload = { exp?: number; role?: string; email_verified?: boolean };

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

/** 307 with a same-origin relative Location — never rewrite the hostname. */
function bounce(pathname: string, search?: Record<string, string>): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: { Location: internalLocation(pathname, search) },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const payload = cookie ? decodePayload(cookie) : null;
  const valid = payload?.exp != null && payload.exp > Date.now() / 1000;

  // Signed in with a live session cookie → auth pages bounce to the app.
  if (valid && isAuthPage(pathname)) {
    return bounce("/chat");
  }

  if (!valid && !isPublic(pathname)) {
    return bounce("/login", { next: pathname });
  }

  // Admin routes need an admin role. Unverified here (UX only) — the admin
  // layout re-checks authoritatively with the Admin SDK.
  if (valid && pathname.startsWith("/admin") && !payload?.role) {
    return bounce("/chat");
  }

  return NextResponse.next();
}

export const config = {
  // API routes handle their own authentication (JSON 401s) — the middleware
  // only guards page routing. Static assets in public/ must be excluded or
  // the browser gets a login-page redirect instead of the file: the manifest
  // fetch follows redirects, so /site.webmanifest → /login produced
  // "Manifest: Line 1, column 1, Syntax error" on logged-out sessions.
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest|json|txt|xml|woff2?)$).*)",
  ],
};
