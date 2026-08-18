"use client";

// Browser-side Supabase client. Real backend only — no demo client.
// NEXT_PUBLIC_* values are inlined by the bundler at build time, so
// `supabaseBrowserConfigured` is a compile-time-known constant per deploy.
// Client components (login/register/settings/...) check it and render an
// honest "Server problem — service not configured" state instead of
// crashing or pretending an API is reachable.
import { createBrowserClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const PLACEHOLDERS = ["YOUR-PROJECT", "your-project", "your-anon-key", "example.com"];

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const supabaseBrowserConfigured =
  Boolean(url) &&
  Boolean(anon) &&
  isValidUrl(url) &&
  !PLACEHOLDERS.some((p) => url.includes(p) || anon.includes(p));

// Public, browser-safe connection info (the anon key is designed to be public).
export const supabasePublic = { url, anonKey: anon } as const;

export function createClient() {
  if (!supabaseBrowserConfigured) {
    throw new Error(
      "SUPABASE_NOT_CONFIGURED: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are missing or invalid. " +
        "Set them in the host environment and redeploy.",
    );
  }
  return createBrowserClient(url, anon);
}
