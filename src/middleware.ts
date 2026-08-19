import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/firebase/session-shared";

// Edge-runtime routing guard.
//
// Firebase session cookies are JWTs, but the Admin SDK needed to verify
// their signature cannot run in Next.js middleware (edge runtime). So this
// middleware only performs an UNVERIFIED presence/expiry decode of the
// cookie payload for routing UX — every server component and API route
// re-verifies the signature with the Admin SDK before trusting anything.

// Public routes (never require authentication).
const PUBLIC_PATHS = [
  "/login", "/register", "/forgot-password", "/reset-password", "/verify",
  "/docs", "/privacy", "/terms", "/support",
  "/emergency", "/certificate/verify", "/scams", "/scams/",
  "/api/health", "/api/ai",
];
const AUTH_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p));
}

function isAuthPage(path: string): boolean {
  return AUTH_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const payload = cookie ? decodePayload(cookie) : null;
  const valid = payload?.exp != null && payload.exp > Date.now() / 1000;

  // Signed in with a live session cookie → auth pages bounce to the app.
  if (valid && isAuthPage(pathname)) {
    return NextResponse.redirect(new URL("/chat", request.url));
  }

  if (!valid && !isPublic(pathname)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Admin routes need an admin role. Unverified here (UX only) — the admin
  // layout re-checks authoritatively with the Admin SDK.
  if (valid && pathname.startsWith("/admin") && !payload?.role) {
    return NextResponse.redirect(new URL("/chat", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // API routes handle their own authentication (JSON 401s) — the middleware
  // only guards page routing.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
