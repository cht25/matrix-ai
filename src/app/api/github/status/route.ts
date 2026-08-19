import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { isGithubConfigured } from "@/lib/env";
import { deleteGithubConnection, getGithubConnection, githubRequest } from "@/lib/server/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!isGithubConfigured()) return NextResponse.json({ configured: false, connected: false });
  const connection = await getGithubConnection(user.uid);
  if (!connection) return NextResponse.json({ configured: true, connected: false, connection: null });
  try {
    await githubRequest(user.uid, "/user");
    return NextResponse.json({ configured: true, connected: true, connection });
  } catch {
    return NextResponse.json({ configured: true, connected: false, connection: null, reauthorize: true });
  }
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  await deleteGithubConnection(user.uid);
  return NextResponse.json({ disconnected: true });
}
