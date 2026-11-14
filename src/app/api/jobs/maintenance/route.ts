// Background maintenance worker (server-to-server; no browser session).
//
//   POST /api/jobs/maintenance      Authorization: Bearer AUTOMATION_WORKER_SECRET
//
// One pass does three things, each safe to repeat:
//   1. continue build runs that are paused or were interrupted by a restart
//      (same run, chat and project — see lib/server/continuation.ts);
//   2. release execution environments left behind by ended/abandoned sessions;
//   3. store the current health of the connected AI provider accounts.
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { adminConfigured, adminDb, nowTs } from "@/lib/firebase/admin";
import { recoverInterruptedRuns } from "@/lib/server/build-resume";
import { cleanupExecutionSessions } from "@/lib/server/execution-env";
import { ensureAccounts, persistAccountStatus } from "@/lib/ai/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_WORKER_SECRET?.trim() ?? "";
  if (secret.length < 32) return NextResponse.json({ error: "WORKER_NOT_CONFIGURED" }, { status: 503 });
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  const supplied = Buffer.from(match?.[1] ?? "");
  const expected = Buffer.from(secret);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!adminConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  const d = adminDb();
  const result: Record<string, unknown> = {};
  const errors: string[] = [];
  try { result.cleanup = await cleanupExecutionSessions(d); } catch { errors.push("cleanup"); }
  try { await ensureAccounts(d, true); await persistAccountStatus(d); result.accounts = "stored"; } catch { errors.push("accounts"); }
  try { result.recovered = await recoverInterruptedRuns(d, { limit: 2, budgetMs: 230_000 }); } catch { errors.push("recovery"); }
  await d.collection("system_settings").doc("maintenance_worker").set({ last_run_at: nowTs(), errors, result: JSON.parse(JSON.stringify(result)) }, { merge: true }).catch(() => undefined);
  return NextResponse.json({ ...result, errors }, { status: errors.length === 3 ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
