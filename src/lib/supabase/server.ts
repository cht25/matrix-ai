import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env, isConfigured, logMissingSupabaseConfig } from "@/lib/env";
import { NotConfiguredError } from "@/lib/data";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createClient() {
  // Real backend only: when Supabase credentials are missing/placeholders,
  // fail fast with a typed error the layout catches and renders as an honest
  // "Server problem" configuration screen — never silently fabricate data.
  if (!isConfigured()) {
    logMissingSupabaseConfig();
    throw new NotConfiguredError();
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
