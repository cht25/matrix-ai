import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { matrixModelRoute, matrixModelStatus } from "@/lib/ai/config";
import { MATRIX_MODEL } from "@/lib/ai/model";
import { providerPublicCode } from "@/lib/ai/provider-error";
import { MAX_ACTIVE_MODELS, getPoolPreference, listModelStatus, setPoolPreference } from "@/lib/ai/models/pool";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The model pool: every registered model with its real, current availability,
 * plus the user's enabled set. Credentials stay server-side.
 * `?check=1` also runs a live reachability probe of the default model and
 * re-reads the provider's model list.
 */
export async function GET(request?: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const check = request ? new URL(request.url).searchParams.get("check") === "1" : true;
  const status = matrixModelStatus();
  const route = matrixModelRoute();
  let health: "online" | "unavailable" | "not-configured" | "unchecked" = route ? "unchecked" : "not-configured";
  let error: string | null = null;
  if (route && check) {
    try {
      health = (await route.client.healthCheck(route.model)) ? "online" : "unavailable";
    } catch (cause) {
      health = "unavailable";
      error = providerPublicCode(cause);
    }
  }
  const d = adminDb();
  const [models, pool, settings] = await Promise.all([
    listModelStatus({ refresh: check }),
    getPoolPreference(d, user.uid),
    d.collection("user_security_settings").doc(user.uid).get().catch(() => null),
  ]);
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
    models,
    pool,
    max_active: MAX_ACTIVE_MODELS,
    reveal_mode: settings?.data()?.stream_reveal_mode ?? "adaptive",
  }, { headers: { "Cache-Control": "private, no-store" } });
}

const poolSchema = z.object({ auto: z.boolean(), enabled: z.array(z.string().max(40)).max(12) });

/** Save which models are active for this user (Chat and Agent share it). */
export async function PUT(request: Request) {
  const csrf = mutationCsrfResponse(request);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  let body: z.infer<typeof poolSchema>;
  try {
    body = poolSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  try {
    const pool = await setPoolPreference(adminDb(), user.uid, body);
    return NextResponse.json({ pool }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const code = error instanceof Error && (error.message === "EMPTY_MODEL_POOL" || error.message === "MODEL_UNAVAILABLE") ? error.message : null;
    if (code) return NextResponse.json({ error: code }, { status: 400 });
    console.error("[MATRIX] saving the model pool failed", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
