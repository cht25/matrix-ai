import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createDemoClient } from "@/lib/demo/demo-client";
import { env, warnIfDemoFallback } from "@/lib/env";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createClient() {
  // Never crash a render when Supabase credentials are missing/placeholders —
  // degrade to the demo client (clearly badged sample data) instead of
  // throwing "Your project's URL and Key are required to create a Supabase
  // client!" in every server component. env.demoMode is also true when demo
  // mode was requested explicitly.
  if (env.demoMode) {
    warnIfDemoFallback();
    return createDemoClient() as unknown as ReturnType<typeof createServerClient>;
  }

  const cookieStore = await cookies();

  return createServerClient(
    env.supabaseUrl,
    env.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component — safe to ignore when middleware
            // refreshes sessions.
          }
        },
      },
    },
  );
}
