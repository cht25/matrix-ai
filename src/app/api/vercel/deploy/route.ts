// Create + monitor a real Vercel deployment. Requires an explicit approval
// flag in the request body (the deploy_approval checkpoint) — the route never
// deploys on a model's say-so alone.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/firebase/session";
import { createVercelDeployment, waitForDeployment, getVercelDeployment, RpcError } from "@/lib/server/vercel";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  vercel_project_id: z.string().min(1).max(120),
  approve: z.literal(true), // explicit deploy approval checkpoint
  target: z.enum(["production", "preview"]).default("production"),
  name: z.string().min(1).max(120).optional(),
  git_source: z
    .object({ type: z.literal("github"), repo: z.string().min(1).max(200), ref: z.string().min(1).max(200) })
    .optional(),
  wait: z.boolean().default(true),
});

// Light per-user rate limit for deployments.
const hits = new Map<string, number[]>();
function rateLimited(uid: string): boolean {
  const now = Date.now();
  const arr = (hits.get(uid) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 5) return true;
  arr.push(now);
  hits.set(uid, arr);
  return false;
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const origin = req.headers.get("origin");
  if (origin) {
    const allowed = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.nextUrl.host;
    let same = false;
    try {
      same = new URL(origin).host === allowed;
    } catch {
      same = false;
    }
    if (!same) return NextResponse.json({ error: "BAD_ORIGIN" }, { status: 403 });
  }
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (rateLimited(user.uid)) return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST — approval (approve: true) is required to deploy" }, { status: 400 });
  }

  try {
    const deployment = await createVercelDeployment(body.vercel_project_id, {
      name: body.name,
      target: body.target,
      gitSource: body.git_source,
    });
    const final = body.wait ? await waitForDeployment(deployment.id) : await getVercelDeployment(deployment.id);
    return NextResponse.json({ deployment: final, approved_by: user.uid });
  } catch (err) {
    if (err instanceof RpcError) return NextResponse.json({ error: err.code }, { status: err.status });
    console.error("[MATRIX] vercel deploy failed", err);
    return NextResponse.json({ error: "VERCEL_ERROR" }, { status: 502 });
  }
}
