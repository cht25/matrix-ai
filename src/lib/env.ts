// Centralised env access. Server-only secrets are never exposed to the client.
// Real services only: there is intentionally no demo mode. If the Supabase
// client config is missing/invalid the app renders honest configuration
// errors instead of pretending to work.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Values that ship in .env.example and mean "not really configured yet".
const PLACEHOLDERS = ["YOUR-PROJECT", "your-project", "your-anon-key", "example.com"];

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// A usable Supabase client needs a well-formed project URL and anon key.
// Empty values, malformed URLs and .env.example placeholders all count as
// "not configured" — @supabase/supabase-js would otherwise throw
// "Your project's URL and Key are required to create a Supabase client!".
const configured =
  Boolean(supabaseUrl) &&
  Boolean(supabaseAnonKey) &&
  isValidUrl(supabaseUrl) &&
  !PLACEHOLDERS.some((p) => supabaseUrl.includes(p) || supabaseAnonKey.includes(p));

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  webhookSecret: process.env.SUPABASE_WEBHOOK_SECRET ?? "",
} as const;

export function isConfigured(): boolean {
  return configured;
}

export function isServerConfigured(): boolean {
  return isConfigured() && Boolean(env.serviceRoleKey && env.groqApiKey);
}

// Log exactly once per process/bundle when Supabase credentials are missing,
// pointing operators at the fix. Uses a global flag because per-module state
// is duplicated across Next.js bundles (middleware, server renderer, ...).
const WARN_FLAG = "__matrixMissingSupabaseConfigWarned";

export function logMissingSupabaseConfig(): void {
  if (configured) return;
  const g = globalThis as Record<string, unknown>;
  if (g[WARN_FLAG]) return;
  g[WARN_FLAG] = true;
  console.error(
    "[MATRIX] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are missing or invalid —\n" +
      "[MATRIX] the app cannot authenticate or load data. Add both variables to your host's\n" +
      "[MATRIX] environment settings (Render: Dashboard → your service → Environment) and redeploy.\n" +
      "[MATRIX] Values: https://supabase.com/dashboard/project/_/settings/api",
  );
}
