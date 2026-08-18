// Data-client factory: real Supabase in production, a clearly-badged demo
// client only when NEXT_PUBLIC_DEMO_MODE=true (development/testing preview).

import "server-only";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { createDemoClient } from "@/lib/demo/demo-client";
import { env } from "@/lib/env";

// Structural data-client surface used by pages. In production this is the
// Supabase server client (RLS enforces authorization); in demo mode it is the
// demo client. All authorization still happens in PostgreSQL.
export type DataClient = {
  auth: {
    getUser(): Promise<{ data: { user: { id: string; email?: string; email_confirmed_at?: string | null } | null }; error: unknown }>;
  };
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: any; error: any }>;
};

export async function getDataClient(): Promise<DataClient> {
  if (env.demoMode) return createDemoClient() as unknown as DataClient;
  return (await createSupabaseServerClient()) as unknown as DataClient;
}

export function isDemoMode(): boolean {
  return env.demoMode;
}

export async function getCurrentUser(db: DataClient) {
  const { data } = await db.auth.getUser();
  return data.user;
}
