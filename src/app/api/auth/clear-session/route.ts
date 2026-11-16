// GET /api/auth/clear-session — clears an invalid/expired/revoked __session
// cookie when a server layout rejects it, preventing a Middleware (/login →
// /chat) ↔ AppLayout (/chat → /login) redirect loop. Valid cookies are never
// cleared by a GET request (prevents CSRF-triggered logouts).

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, verifySession } from "@/lib/firebase/session";
import { internalLocation } from "@/lib/routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectRelative(location: string): NextResponse {
  return new NextResponse(null, {
    status: 307,
    headers: {
      Location: location,
      "Cache-Control": "private, no-store, no-cache, must-revalidate",
    },
  });
}

export async function GET(req: NextRequest) {
  const cookieValue = req.cookies.get(SESSION_COOKIE)?.value;
  const rawNext = req.nextUrl.searchParams.get("next");
  const isSafePath =
    typeof rawNext === "string" && rawNext.startsWith("/") && !rawNext.startsWith("//");
  const safeLoginTarget =
    isSafePath && !rawNext.startsWith("/login")
      ? internalLocation("/login", { next: rawNext })
      : "/login";

  if (cookieValue) {
    try {
      await verifySession(cookieValue);
      // Cookie is actually valid — never wipe a valid session on GET.
      const dest =
        isSafePath && !rawNext.startsWith("/login")
          ? internalLocation(rawNext)
          : "/chat";
      return redirectRelative(dest);
    } catch {
      /* invalid/expired/revoked cookie: clear below */
    }
  }

  const res = redirectRelative(safeLoginTarget);
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(req), maxAge: 0 });
  return res;
}
