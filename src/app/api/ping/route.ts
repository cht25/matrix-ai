import { NextResponse } from "next/server";
import { APP_BUILD_NUMBER, APP_VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: HEADERS });
}

export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: HEADERS });
}

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      version: APP_VERSION,
      build: APP_BUILD_NUMBER,
      ts: new Date().toISOString(),
    },
    { status: 200, headers: HEADERS },
  );
}
