// List the Vercel projects the server token can access (never exposes the token).
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { listVercelProjects, RpcError } from "@/lib/server/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  try {
    return NextResponse.json({ projects: await listVercelProjects() });
  } catch (err) {
    if (err instanceof RpcError) return NextResponse.json({ error: err.code }, { status: err.status });
    console.error("[MATRIX] vercel projects failed", err);
    return NextResponse.json({ error: "VERCEL_ERROR" }, { status: 502 });
  }
}
