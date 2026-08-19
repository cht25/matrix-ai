import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { listGithubRepos } from "@/lib/server/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  try {
    return NextResponse.json({ repositories: await listGithubRepos(user.uid) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GITHUB_ERROR";
    const status = message === "GITHUB_NOT_CONNECTED" ? 409 : message.startsWith("GITHUB_401") ? 401 : 502;
    return NextResponse.json({ error: status === 409 ? "GITHUB_NOT_CONNECTED" : "GITHUB_ERROR" }, { status });
  }
}
