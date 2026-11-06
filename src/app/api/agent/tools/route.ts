// Agent Studio tool gateway: GET lists registered tools (descriptions only),
// POST executes one through the guarded server-side gateway — the model can
// request a tool, but only this route can run it, after authorization+audit.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { describeTools, executeAgentTool } from "@/lib/server/tool-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  return NextResponse.json({ tools: describeTools() });
}

const bodySchema = z.object({
  tool: z.string().min(3).max(64),
  args: z.record(z.unknown()).optional(),
  approval_id: z.string().max(120).optional(),
  dry_run: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
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
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  const result = await executeAgentTool(adminDb(), user, body.tool, body.args ?? {}, {
    approvalId: body.approval_id,
    dryRun: body.dry_run,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : result.error === "APPROVAL_REQUIRED" || result.error === "MISSING_PERMISSIONS" ? 403 : 200 });
}
