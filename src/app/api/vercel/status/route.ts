// Vercel engine status — honest: reports configured/not-configured, never fakes.
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { isVercelConfigured, vercelConfig } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  return NextResponse.json({
    configured: isVercelConfigured(),
    appsDomain: vercelConfig().appsDomain,
    teamIdConfigured: Boolean(vercelConfig().teamId),
  });
}
