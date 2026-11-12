// POST /api/devices/esp32/pair — single-use pairing code exchange for ESP32 nodes.

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { completeEsp32Pairing } from "@/lib/server/esp32";
import { RpcError } from "@/lib/server/errors";
import { ESP32_MAX_BODY_BYTES } from "@/lib/esp32";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (!raw || raw.length > ESP32_MAX_BODY_BYTES) {
      return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    const result = await completeEsp32Pairing(adminDb(), body);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RpcError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "BODY_INVALID" }, { status: 400 });
    }
    return NextResponse.json({ error: "PAIRING_FAILED" }, { status: 500 });
  }
}
