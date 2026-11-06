// MATRIX Connect — create a short-lived, signed QR pairing challenge.
// Returns the QR payload plus a rendered PNG data URL. The payload contains
// NO tokens or credentials — only a one-time challenge id + HMAC signature.
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { createPairingChallenge } from "@/lib/server/pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  let deviceLabel = "";
  try {
    const body = (await req.json()) as { device_label?: unknown };
    if (typeof body.device_label === "string") deviceLabel = body.device_label;
  } catch {
    // empty body is fine
  }
  try {
    const challenge = await createPairingChallenge(adminDb(), user, { device_label: deviceLabel });
    const qrDataUrl = await QRCode.toDataURL(challenge.qr_payload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    });
    return NextResponse.json({ ...challenge, qr_data_url: qrDataUrl });
  } catch (error) {
    console.error("[MATRIX] pairing challenge creation failed", error);
    return NextResponse.json({ error: "PAIRING_CREATE_FAILED" }, { status: 500 });
  }
}
