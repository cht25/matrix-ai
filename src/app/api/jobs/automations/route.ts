import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminConfigured, adminDb, nowTs } from "@/lib/firebase/admin";
import { runDueAutomations } from "@/lib/server/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Server-to-server worker endpoint. No browser session or CORS access. */
export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_WORKER_SECRET?.trim() ?? "";
  if (secret.length < 32) return NextResponse.json({ error: "WORKER_NOT_CONFIGURED" }, { status: 503 });
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  const supplied = Buffer.from(match?.[1] ?? "");
  const expected = Buffer.from(secret);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!adminConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  let limit = 10;
  try { const body = await request.json().catch(() => ({})); limit = z.number().int().min(1).max(20).parse((body as { limit?: number }).limit ?? 10); }
  catch { return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 }); }
  try {
    const result = await runDueAutomations(adminDb(), { limit });
    await adminDb().collection("system_settings").doc("automation_worker").set({ last_success_at: nowTs(), attempted: result.attempted, succeeded: result.succeeded }, { merge: true }).catch(() => {});
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }
  catch { return NextResponse.json({ error: "WORKER_BATCH_FAILED" }, { status: 503 }); }
}
