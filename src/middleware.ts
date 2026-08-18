import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { env, warnIfDemoFallback } from "@/lib/env";

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

  // Demo mode is either explicit (NEXT_PUBLIC_DEMO_MODE=true) or an automatic
  // fallback when Supabase credentials are missing/placeholders — without the
  // fallback, createServerClient below would throw on EVERY request and take
  // the whole site down ("Your project's URL and Key are required...").
  if (env.demoMode) {
    warnIfDemoFallback();
    // Demo preview: /login (and friends) render so the auth experience is
    // visible; the root page still routes the simulated user to /chat.
    return NextResponse.next();
  }

  let supabase: ReturnType<typeof createServerClient>;
  let response = NextResponse.next({ request });
  try {
    supabase = createServerClient(
      env.supabaseUrl,
      env.supabaseAnonKey,
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
  } catch (err) {
    // Defensive: misconfigured (but non-empty) credentials must never take
    // the site down. Degrade to demo pass-through for this request.
    console.error("[MATRIX] Failed to create Supabase client in middleware — serving request without auth.", err);
    warnIfDemoFallback();
    return NextResponse.next();
  }

  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch (err) {
    // Unreachable Supabase project / network blip: treat as signed out
    // instead of erroring the request.
    console.error("[MATRIX] Supabase auth check failed in middleware — treating request as signed out.", err);
  }

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
    try {
      const { data: isAdmin } = await supabase.rpc("is_admin");
      if (!isAdmin) {
        return NextResponse.redirect(new URL("/chat", request.url));
      }
    } catch (err) {
      console.error("[MATRIX] Admin role check failed in middleware.", err);
      return NextResponse.redirect(new URL("/chat", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
