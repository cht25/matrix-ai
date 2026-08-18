// GET /api/health — honest, machine-readable service health for operators and
// uptime checks. No secrets are returned; every probe is a live network call.
//
//   200 { ok: true,  supabase: "reachable",          ai: "online" | "unavailable" | "unknown", checkedAt }
//   503 { ok: false, supabase: "not-configured", … } — deployment lacks env vars
//   503 { ok: false, supabase: "unreachable", … }    — project URL/key wrong or project paused/down

import { NextResponse } from "next/server";
import { env, isConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date().toISOString();

  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, supabase: "not-configured", ai: "not-configured", checkedAt },
      { status: 503 },
    );
  }

  let supabase: "reachable" | "unreachable" = "unreachable";
  try {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/health`, {
      headers: { apikey: env.supabaseAnonKey },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) supabase = "reachable";
  } catch {
    supabase = "unreachable";
  }

  let ai: "online" | "unavailable" | "unknown" = "unknown";
  if (supabase === "reachable") {
    try {
      const res = await fetch(`${env.supabaseUrl}/functions/v1/ai-gateway`, {
        method: "POST",
        headers: { apikey: env.supabaseAnonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health" }),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      ai = res.ok && data.status === "online" ? "online" : "unavailable";
    } catch {
      ai = "unavailable";
    }
  }

  const ok = supabase === "reachable";
  return NextResponse.json({ ok, supabase, ai, checkedAt }, { status: ok ? 200 : 503 });
}
