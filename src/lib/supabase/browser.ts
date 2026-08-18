"use client";

// Browser-side data client: the real Supabase browser client in production,
// the clearly-badged demo client when NEXT_PUBLIC_DEMO_MODE=true OR when the
// Supabase URL/key were absent (or left as .env.example placeholders) at
// build time — NEXT_PUBLIC_* variables are inlined by the bundler, so a
// deployment built without credentials would otherwise crash in the browser
// with "Your project's URL and Key are required to create a Supabase
// client!". Add the variables to the host and redeploy to switch to the real
// backend (Render redeploys automatically on env changes).
import { createBrowserClient } from "@supabase/ssr";
import { createDemoClient } from "@/lib/demo/demo-client";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const PLACEHOLDERS = ["YOUR-PROJECT", "your-project", "your-anon-key", "example.com"];

function isConfigured(): boolean {
  return Boolean(url) && Boolean(anon) && !PLACEHOLDERS.some((p) => url.includes(p) || anon.includes(p));
}

export function createClient() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true" || !isConfigured()) {
    return createDemoClient() as unknown as ReturnType<typeof createBrowserClient>;
  }
  return createBrowserClient(url, anon);
}
