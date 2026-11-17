import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/firebase/session";
import { cloudflareCredentials, testCloudflareModel } from "@/lib/ai/cloudflare";
import { routeForModel } from "@/lib/ai/config";
import { listModelStatus, recordModelProbeResult } from "@/lib/ai/models/pool";
import { modelByKey } from "@/lib/ai/models/registry";
import { PROBE_STATE_LABEL, type ModelProbeState } from "@/lib/ai/models/types";
import { AIProviderError, sanitizeProviderDetail } from "@/lib/ai/provider-error";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z.object({
  model_key: z.string().min(1).max(64),
});

function probeStateFromProviderError(error: AIProviderError): ModelProbeState {
  if (error.code === "CLOUDFLARE_QUOTA_EXHAUSTED" || error.type === "billing") return "out_of_capacity";
  if (error.type === "authentication") return error.status === 403 ? "permission_denied" : "invalid_credentials";
  if (error.type === "rate_limit") return "rate_limited";
  if (error.modelUnavailable) return "model_not_found";
  return "temporarily_unavailable";
}

/**
 * POST /api/models/test — safe server-side connectivity check for one
 * registered model. Never accepts or echoes credentials/tokens.
 */
export async function POST(request: Request) {
  const csrf = mutationCsrfResponse(request);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  let body: z.infer<typeof testSchema>;
  try {
    body = testSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  const spec = modelByKey(body.model_key);
  if (!spec) {
    return NextResponse.json({ error: "MODEL_NOT_FOUND" }, { status: 404 });
  }

  const testedAt = new Date().toISOString();

  if (spec.provider === "cloudflare") {
    const creds = cloudflareCredentials();
    if (!creds) {
      recordModelProbeResult(spec.key, {
        ok: false,
        state: "configuration_missing",
        code: "CLOUDFLARE_NOT_CONFIGURED",
        message: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not configured on the server.",
        status: null,
        at: testedAt,
      });
      const models = await listModelStatus({ refresh: true });
      const updated = models.find((m) => m.key === spec.key) ?? null;
      return NextResponse.json(
        {
          ok: false,
          model_key: spec.key,
          model_id: spec.id,
          provider: spec.providerLabel,
          status_code: "configuration_missing",
          status_label: PROBE_STATE_LABEL.configuration_missing,
          availability: "not_configured",
          latency_ms: 0,
          detail: "Server environment variables CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are missing.",
          checked_at: testedAt,
          model: updated,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const result = await testCloudflareModel(creds, spec.id);
    recordModelProbeResult(spec.key, {
      ok: result.ok,
      state: result.state,
      code: result.code,
      message: result.message,
      status: result.status,
      at: testedAt,
    });
    const models = await listModelStatus({ refresh: true });
    const updated = models.find((m) => m.key === spec.key) ?? null;
    return NextResponse.json(
      {
        ok: result.ok,
        model_key: spec.key,
        model_id: spec.id,
        provider: spec.providerLabel,
        status_code: result.state,
        status_label: PROBE_STATE_LABEL[result.state],
        availability: updated?.availability ?? (result.ok ? "available" : "unverified"),
        latency_ms: result.latencyMs,
        detail: result.message,
        checked_at: testedAt,
        model: updated,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const route = routeForModel(spec);
  if (!route) {
    recordModelProbeResult(spec.key, {
      ok: false,
      state: "configuration_missing",
      code: "PROVIDER_NOT_CONFIGURED",
      message: "No server credential is installed for this model.",
      status: null,
      at: testedAt,
    });
    const models = await listModelStatus({ refresh: true });
    const updated = models.find((m) => m.key === spec.key) ?? null;
    return NextResponse.json(
      {
        ok: false,
        model_key: spec.key,
        model_id: spec.id,
        provider: spec.providerLabel,
        status_code: "configuration_missing",
        status_label: PROBE_STATE_LABEL.configuration_missing,
        availability: "not_configured",
        latency_ms: 0,
        detail: "No server credential is configured for this model.",
        checked_at: testedAt,
        model: updated,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const started = Date.now();
  try {
    const response = await route.client.chat({
      model: route.model,
      messages: [{ role: "user", content: "Reply with OK." }],
      maxTokens: 12,
      temperature: 0,
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Math.max(1, Date.now() - started);
    const ok = Boolean(response.content?.trim());
    const state: ModelProbeState = ok ? "available" : "temporarily_unavailable";
    const message = ok ? `${spec.label} responded cleanly.` : `${spec.label} returned an empty response.`;
    recordModelProbeResult(spec.key, {
      ok,
      state,
      code: ok ? "OK" : "EMPTY_RESPONSE",
      message,
      status: 200,
      at: testedAt,
    });
    const models = await listModelStatus({ refresh: true });
    const updated = models.find((m) => m.key === spec.key) ?? null;
    return NextResponse.json(
      {
        ok,
        model_key: spec.key,
        model_id: spec.id,
        provider: route.provider,
        status_code: state,
        status_label: PROBE_STATE_LABEL[state],
        availability: updated?.availability ?? (ok ? "available" : "unverified"),
        latency_ms: latencyMs,
        detail: message,
        checked_at: testedAt,
        model: updated,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const latencyMs = Math.max(1, Date.now() - started);
    let state: ModelProbeState = "temporarily_unavailable";
    let code = "PROVIDER_PROBE_FAILED";
    let status: number | null = null;
    let message = "Connectivity check failed.";
    if (error instanceof AIProviderError) {
      state = probeStateFromProviderError(error);
      code = error.code ?? error.type.toUpperCase();
      status = error.status ?? null;
      message = sanitizeProviderDetail(error.detail);
    } else if (error instanceof Error) {
      message = sanitizeProviderDetail(error.message);
    }
    recordModelProbeResult(spec.key, { ok: false, state, code, message, status, at: testedAt });
    const models = await listModelStatus({ refresh: true });
    const updated = models.find((m) => m.key === spec.key) ?? null;
    return NextResponse.json(
      {
        ok: false,
        model_key: spec.key,
        model_id: spec.id,
        provider: route.provider,
        status_code: state,
        status_label: PROBE_STATE_LABEL[state],
        availability: updated?.availability ?? "unverified",
        latency_ms: latencyMs,
        detail: message,
        checked_at: testedAt,
        model: updated,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
