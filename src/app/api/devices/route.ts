// MATRIX Connect — list the account's paired devices / revoke one.
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { listDevices, revokeDevice, RpcError } from "@/lib/server/pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  return NextResponse.json({ devices: await listDevices(adminDb(), user.uid) });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  try {
    await revokeDevice(adminDb(), user, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RpcError) return NextResponse.json({ error: error.code }, { status: error.status });
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
