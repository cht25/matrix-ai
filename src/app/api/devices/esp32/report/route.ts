// POST /api/devices/esp32/report — authenticated ESP32 telemetry & event report.

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { reportEsp32Reading } from "@/lib/server/esp32";
import { RpcError } from "@/lib/server/errors";
import { ESP32_MAX_BODY_BYTES } from "@/lib/esp32";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") ?? "";
    const raw = await req.text();
    if (!raw || raw.length > ESP32_MAX_BODY_BYTES) {
      return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
    }
    const payload = JSON.parse(raw) as unknown;
    const result = await reportEsp32Reading(adminDb(), auth, payload);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RpcError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "BODY_INVALID" }, { status: 400 });
    }
    return NextResponse.json({ error: "REPORT_FAILED" }, { status: 500 });
  }
}
