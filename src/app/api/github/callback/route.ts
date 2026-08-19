import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { env, isGithubConfigured } from "@/lib/env";
import { saveGithubConnection } from "@/lib/server/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameState(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function finish(req: NextRequest, status: string) {
  const response = NextResponse.redirect(new URL(`/chat?mode=agent&github=${encodeURIComponent(status)}`, req.url));
  response.cookies.set("matrix_github_oauth", "", { maxAge: 0, path: "/api/github/callback" });
  return response;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/chat?mode=agent", req.url));
  if (!isGithubConfigured()) return finish(req, "not-configured");

  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const expected = req.cookies.get("matrix_github_oauth")?.value ?? "";
  if (!code || !state || !expected || !sameState(expected, state)) return finish(req, "invalid-state");

  try {
    const callback = env.github.callbackUrl || new URL("/api/github/callback", req.url).toString();
    const exchange = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.github.clientId,
        client_secret: env.github.clientSecret,
        code,
        redirect_uri: callback,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData = (await exchange.json()) as { access_token?: string; error?: string };
    if (!exchange.ok || !tokenData.access_token || tokenData.error) return finish(req, "denied");

    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenData.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MATRIX-AI-Agent",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileResponse.ok) return finish(req, "profile-failed");
    const profile = (await profileResponse.json()) as { login?: string; name?: string | null; avatar_url?: string | null };
    if (!profile.login) return finish(req, "profile-failed");

    await saveGithubConnection(user.uid, tokenData.access_token, {
      login: profile.login,
      name: profile.name,
      avatar_url: profile.avatar_url,
    });
    return finish(req, "connected");
  } catch (error) {
    console.error("[MATRIX] GitHub OAuth callback failed.", error);
    return finish(req, "failed");
  }
}
