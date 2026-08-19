import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { pushAgentFiles, validatePushFiles } from "@/lib/server/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // This route is intentionally reserved for the explicit Agent review flow.
  if (body.source !== "agent") return NextResponse.json({ error: "AGENT_MODE_REQUIRED" }, { status: 403 });

  try {
    const files = validatePushFiles(body.files);
    const result = await pushAgentFiles(user.uid, {
      repository: typeof body.repository === "string" ? body.repository : "",
      branch: typeof body.branch === "string" ? body.branch : "",
      message: typeof body.message === "string" ? body.message : "",
      files,
    });
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "GITHUB_PUSH_FAILED";
    const status = code === "GITHUB_NOT_CONNECTED" ? 409 :
      code === "GITHUB_PUSH_FORBIDDEN" ? 403 :
      code.startsWith("GITHUB_409") || code.startsWith("GITHUB_422") ? 409 :
      ["FILES_INVALID", "FILES_TOO_LARGE", "TARGET_INVALID", "COMMIT_MESSAGE_REQUIRED"].includes(code) ? 400 : 502;
    console.error("[MATRIX] Agent GitHub push failed.", code);
    return NextResponse.json({ error: code }, { status });
  }
}
