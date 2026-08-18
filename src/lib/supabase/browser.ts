"use client";

// Browser-side data client: the real Supabase browser client in production,
// the clearly-badged demo client when NEXT_PUBLIC_DEMO_MODE=true.
import { createBrowserClient } from "@supabase/ssr";
import { createDemoClient } from "@/lib/demo/demo-client";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export function createClient() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
    return createDemoClient() as unknown as ReturnType<typeof createBrowserClient>;
  }
  return createBrowserClient(url, anon);
}
