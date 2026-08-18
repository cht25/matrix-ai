// Centralised env access. Server-only secrets are never exposed to the client.

export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  demoMode: process.env.NEXT_PUBLIC_DEMO_MODE === "true",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  webhookSecret: process.env.SUPABASE_WEBHOOK_SECRET ?? "",
} as const;

export function isConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}

export function isServerConfigured(): boolean {
  return isConfigured() && Boolean(env.serviceRoleKey && env.groqApiKey);
}
