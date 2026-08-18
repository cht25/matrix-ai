import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Public routes (never require authentication).
const PUBLIC_PATHS = [
  "/login", "/register", "/forgot-password", "/reset-password", "/verify",
  "/docs", "/privacy", "/terms", "/support",
  "/emergency", "/certificate/verify", "/scams", "/scams/",
];
const AUTH_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p));
}

function isAuthPage(path: string): boolean {
  return AUTH_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

  if (demoMode) {
    // Demo preview: /login (and friends) render so the auth experience is
    // visible; the root page still routes the simulated user to /chat.
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user && isAuthPage(pathname)) {
    return NextResponse.redirect(new URL("/chat", request.url));
  }

  if (!user && !isPublic(pathname)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Admin routes require an admin role (RBAC check server-side).
  if (user && pathname.startsWith("/admin")) {
    const { data: isAdmin } = await supabase.rpc("is_admin");
    if (!isAdmin) {
      return NextResponse.redirect(new URL("/chat", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
