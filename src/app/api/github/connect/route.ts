import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { env, isGithubConfigured } from "@/lib/env";
import { GithubOAuthConfigError, githubOAuthUrls, githubResultPath, githubReturnPath, githubOwnerBinding } from "@/lib/server/github-oauth-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let urls: ReturnType<typeof githubOAuthUrls>;
  try { urls = githubOAuthUrls(req.url); }
  catch (error) {
    const code = error instanceof GithubOAuthConfigError ? error.code : "GITHUB_APP_URL_INVALID";
    return NextResponse.json({ error: code, detail: "Set NEXT_PUBLIC_APP_URL to this service's HTTPS origin and register GITHUB_OAUTH_CALLBACK_URL as its /api/github/callback URL." }, { status: 503 });
  }
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/chat?mode=agent", urls.origin), 303);
  const destination = githubReturnPath(req.nextUrl.searchParams.get("next"));
  if (!isGithubConfigured()) {
    return NextResponse.redirect(new URL(githubResultPath(destination, "not-configured"), urls.origin), 303);
  }

  const state = randomBytes(24).toString("base64url");
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.github.clientId);
  authorize.searchParams.set("redirect_uri", urls.callback);
  authorize.searchParams.set("scope", "read:user user:email repo");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "true");

  const response = NextResponse.redirect(authorize);
  for (const [name, value] of [["matrix_github_oauth", state], ["matrix_github_oauth_return", destination], ["matrix_github_oauth_owner", githubOwnerBinding(state, user.uid, env.github.tokenEncryptionKey)]]) {
    response.cookies.set(name, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: urls.origin.startsWith("https://"),
      maxAge: 10 * 60,
      path: "/api/github/callback",
    });
  }
  return response;
}
