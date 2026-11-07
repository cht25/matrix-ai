// MATRIX Connect — list the account's paired devices / revoke one.
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getApiSessionUser, deviceScopeResponse } from "@/lib/firebase/device-session";
import { listDevices, revokeDevice, RpcError } from "@/lib/server/pairing";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getApiSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const denied = deviceScopeResponse(user, "devices:read");
  if (denied) return denied;
  return NextResponse.json({ devices: await listDevices(adminDb(), user.uid) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getApiSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const denied = deviceScopeResponse(user, "devices:write");
  if (denied) return denied;
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
