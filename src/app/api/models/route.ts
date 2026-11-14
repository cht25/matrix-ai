import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { matrixModelRoute, matrixModelStatus } from "@/lib/ai/config";
import { MATRIX_MODEL } from "@/lib/ai/model";
import { providerPublicCode } from "@/lib/ai/provider-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one MATRIX model and its live status. There is no catalogue and no
 * selection: this endpoint is read-only. Credentials stay server-side.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const status = matrixModelStatus();
  const route = matrixModelRoute();
  let health: "online" | "unavailable" | "not-configured" = "not-configured";
  let error: string | null = null;
  if (route) {
    try {
      health = (await route.client.healthCheck(route.model)) ? "online" : "unavailable";
    } catch (cause) {
      health = "unavailable";
      error = providerPublicCode(cause);
    }
  }
  const settings = await adminDb().collection("user_security_settings").doc(user.uid).get().catch(() => null);
  return NextResponse.json({
    model: {
      id: status.model,
      label: MATRIX_MODEL.label,
      provider: status.provider,
      configured: status.configured,
      streaming: MATRIX_MODEL.streaming,
      tool_calling: MATRIX_MODEL.toolCalling,
      vision: MATRIX_MODEL.vision,
      health,
      error,
      checked_at: new Date().toISOString(),
    },
    used_for: ["Chat", "Agent", "Website generation", "Project editing", "Code", "Debugging", "Research", "Deployment assistance", "Voice transcripts"],
    reveal_mode: settings?.data()?.stream_reveal_mode ?? "adaptive",
  }, { headers: { "Cache-Control": "private, no-store" } });
}
