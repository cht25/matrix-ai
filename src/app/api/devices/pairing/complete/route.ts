// MATRIX Connect — complete pairing from a scanned QR payload.
// The scanning device must be signed in; the device is registered under the
// challenge owner's account with scoped authorization. One-time + expiring.
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { completePairing, RpcError } from "@/lib/server/pairing";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  qr_payload: z.string().min(10).max(2000),
  device_name: z.string().min(1).max(80),
  device_type: z.string().min(1).max(40),
  platform: z.string().min(1).max(40),
});

export async function POST(req: Request) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  try {
    const { access_token, access_token_expires_at, ...device } = await completePairing(adminDb(), user, body);
    return NextResponse.json({ device, access_token, access_token_expires_at }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RpcError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    console.error("[MATRIX] pairing completion failed", error);
    return NextResponse.json({ error: "PAIRING_FAILED" }, { status: 500 });
  }
}
