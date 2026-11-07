// =============================================================================
// MATRIX AI — /api/ai/compare: multi-model comparison.
//
// Sends the SAME redacted prompt to several routing lanes in parallel and
// returns one attributed result per lane (provider + model + content or an
// honest error). Compare runs are ephemeral by design: they are NOT appended
// to a conversation — saving a comparison is a separate explicit action.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { getApiSessionUser, deviceScopeResponse } from "@/lib/firebase/device-session";
import { createAIRoutesFromDb, type AIRouteTarget } from "@/lib/ai/config";
import { decideRoute } from "@/lib/ai/router";
import { buildModeSystemMessages } from "@/lib/ai/prompts";
import { redactPII } from "@/lib/ai/pii";
import { isChatMode, isModelLane, type ChatMode, type ModelLane } from "@/lib/ai/modes";
import type { AIMessage } from "@/lib/ai/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { parseCompareLanes, MAX_COMPARE_LANES, MAX_COMPARE_MESSAGE } from "@/lib/ai/compare";
import { mutationCsrfResponse } from "@/lib/server/request-security";

const MAX_LANES = MAX_COMPARE_LANES;
const MAX_MESSAGE = MAX_COMPARE_MESSAGE;

// Lightweight per-user rate limit for the expensive compare endpoint.
const hits = new Map<string, number[]>();
function rateLimited(uid: string, limit = 6, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(uid) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) return true;
  arr.push(now);
  hits.set(uid, arr);
  return false;
}

type LaneResult = {
  lane: ModelLane;
  provider: string;
  model: string;
  ok: boolean;
  content?: string;
  error?: string;
  latency_ms?: number;
  usage?: unknown;
};

async function logUsage(d: ReturnType<typeof adminDb>, userId: string, model: string, status: string, latencyMs: number, requestId: string) {
  try {
    await d.collection("ai_usage_logs").add({
      user_id: userId,
      request_type: "compare",
      model,
      provider: "multi-lane",
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: Math.round(latencyMs),
      status,
      request_id: requestId,
      created_at: nowTs(),
    });
  } catch (err) {
    console.warn("[MATRIX] compare usage log failed", err);
  }
}

async function runLane(
  d: ReturnType<typeof adminDb>,
  uid: string,
  lane: ModelLane,
  mode: ChatMode,
  message: string,
  requestId: string,
): Promise<LaneResult> {
  const started = Date.now();
  const route = decideRoute({ mode, message, lane });
  const targets: AIRouteTarget[] = await createAIRoutesFromDb(d, route.coding);
  const target = targets[0];
  if (!target) {
    return { lane, provider: "none", model: "unconfigured", ok: false, error: "AI_GATEWAY_NOT_CONFIGURED" };
  }
  const messages: AIMessage[] = [
    ...buildModeSystemMessages(mode, ""),
    { role: "user", content: message },
  ];
  try {
    const res = await target.client.chat({
      model: target.model,
      messages,
      temperature: route.coding ? 0.3 : 0.5,
      maxTokens: route.coding ? 3200 : 1600,
      requestId: `${requestId}:${lane}`,
    });
    await logUsage(d, uid, `${target.provider}/${target.model}`, "ok", Date.now() - started, requestId);
    return {
      lane,
      provider: target.provider,
      model: target.model,
      ok: true,
      content: res.content,
      latency_ms: Date.now() - started,
      usage: res.usage ?? undefined,
    };
  } catch (err) {
    await logUsage(d, uid, `${target.provider}/${target.model}`, "error", Date.now() - started, requestId);
    const code = err instanceof Error ? err.message.slice(0, 120) : "PROVIDER_ERROR";
    // Honest failure with attribution — never a fabricated answer.
    return { lane, provider: target.provider, model: target.model, ok: false, error: code, latency_ms: Date.now() - started };
  }
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getApiSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const denied = deviceScopeResponse(user, "chat:write");
  if (denied) return denied;
  if (rateLimited(user.uid)) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  if (!rawMessage) return NextResponse.json({ error: "MESSAGE_REQUIRED" }, { status: 400 });
  if (rawMessage.length > MAX_MESSAGE) return NextResponse.json({ error: "MESSAGE_TOO_LONG" }, { status: 400 });

  const mode: ChatMode = isChatMode(body.mode) ? body.mode : "general";
  const lanes = parseCompareLanes(body.lanes);
  if (lanes.length === 0) return NextResponse.json({ error: "NO_VALID_LANES" }, { status: 400 });

  const requestId = `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const redaction = redactPII(rawMessage);
  const d = adminDb();

  const results = await Promise.all(lanes.map((lane) => runLane(d, user.uid, lane, mode, redaction.redacted, requestId)));

  return NextResponse.json({
    request_id: requestId,
    mode,
    results,
    note: "Comparison is ephemeral and attributed per lane; nothing is saved to a conversation.",
  });
}
