// GET /api/health — honest, machine-readable service health for operators and
// uptime checks. No secrets are returned; every probe is a live network call.
//
//   200 { ok: true,  firebase: "reachable", ai: "online"|"unavailable"|"unknown", checkedAt }
//   503 { ok: false, firebase: "not-configured"|"unreachable", … }

import { NextResponse } from "next/server";
import { isConfigured, isAiConfigured } from "@/lib/env";
import { adminConfigured } from "@/lib/firebase/admin";
import { createProvider } from "@/lib/ai/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date().toISOString();

  if (!isConfigured() || !adminConfigured()) {
    return NextResponse.json(
      { ok: false, firebase: "not-configured", ai: isAiConfigured() ? "unknown" : "not-configured", checkedAt },
      { status: 503 },
    );
  }

  let firebase: "reachable" | "unreachable" = "unreachable";
  try {
    const { adminDb } = await import("@/lib/firebase/admin");
    // Minimal live read (also proves the service account works).
    await adminDb().collection("countries").limit(1).get();
    firebase = "reachable";
  } catch {
    firebase = "unreachable";
  }

  let ai: "online" | "unavailable" | "unknown" = "unknown";
  if (isAiConfigured()) {
    const provider = createProvider();
    ai = provider && (await provider.healthCheck()) ? "online" : "unavailable";
  }

  const ok = firebase === "reachable";
  return NextResponse.json({ ok, firebase, ai, checkedAt }, { status: ok ? 200 : 503 });
}
