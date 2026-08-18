import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { env, isConfigured, logMissingSupabaseConfig } from "@/lib/env";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Public routes (never require authentication).
const PUBLIC_PATHS = [
  "/login", "/register", "/forgot-password", "/reset-password", "/verify",
  "/docs", "/privacy", "/terms", "/support",
  "/emergency", "/certificate/verify", "/scams", "/scams/",
  "/api/health",
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

  // Supabase not configured (missing/invalid/placeholder env): do not attempt
  // any auth work — let requests through so the layouts can render an honest
  // "Server problem — service not configured" screen. There is no demo mode;
  // we never fabricate a session or data.
  if (!isConfigured()) {
    logMissingSupabaseConfig();
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
    // Defensive: misconfigured credentials must never take the site down.
    console.error("[MATRIX] Failed to create Supabase client in middleware — passing request through without auth.", err);
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
