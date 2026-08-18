// Data-client factory. Real Supabase server client only — RLS enforces
// authorization in PostgreSQL; all authorization happens in the database.
// There is no demo client: when Supabase is not configured this throws a
// typed NotConfiguredError so pages/layouts can render an honest
// configuration-error screen instead of pretending to load data.

import "server-only";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { isConfigured, logMissingSupabaseConfig } from "@/lib/env";

export class NotConfiguredError extends Error {
  readonly code = "SUPABASE_NOT_CONFIGURED" as const;
  constructor() {
    super("Supabase client configuration is missing (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).");
    this.name = "NotConfiguredError";
  }
}

export function isNotConfiguredError(err: unknown): err is NotConfiguredError {
  return err instanceof NotConfiguredError || (typeof err === "object" && err !== null && (err as { code?: string }).code === "SUPABASE_NOT_CONFIGURED");
}

// Structural data-client surface used by pages. This is the Supabase server
// client (RLS enforces authorization).
export type DataClient = {
  auth: {
    getUser(): Promise<{ data: { user: { id: string; email?: string; email_confirmed_at?: string | null } | null }; error: unknown }>;
  };
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: any; error: any }>;
};

export async function getDataClient(): Promise<DataClient> {
  if (!isConfigured()) {
    logMissingSupabaseConfig();
    throw new NotConfiguredError();
  }
  return (await createSupabaseServerClient()) as unknown as DataClient;
}

export async function getCurrentUser(db: DataClient) {
  const { data } = await db.auth.getUser();
  return data.user;
}
