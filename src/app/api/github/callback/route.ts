import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { env, isGithubConfigured } from "@/lib/env";
import { saveGithubConnection } from "@/lib/server/github";
import { GithubOAuthConfigError, githubOAuthUrls, githubResultPath, githubReturnPath, githubOwnerBinding } from "@/lib/server/github-oauth-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameState(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function finish(origin: string, status: string, returnPath?: string) {
  const response = NextResponse.redirect(new URL(githubResultPath(returnPath ?? "", status), origin), 303);
  for (const name of ["matrix_github_oauth", "matrix_github_oauth_return", "matrix_github_oauth_owner"]) {
    response.cookies.set(name, "", { maxAge: 0, path: "/api/github/callback" });
  }
  return response;
}

export async function GET(req: NextRequest) {
  let urls: ReturnType<typeof githubOAuthUrls>;
  try { urls = githubOAuthUrls(req.url); }
  catch (error) {
    const code = error instanceof GithubOAuthConfigError ? error.code : "GITHUB_APP_URL_INVALID";
    return NextResponse.json({ error: code, detail: "Configure NEXT_PUBLIC_APP_URL and the matching GitHub OAuth callback URL for this HTTPS service." }, { status: 503 });
  }
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const denied = req.nextUrl.searchParams.has("error");
  // Visiting the callback directly is not an OAuth attempt. Never call the
  // token endpoint or claim that a GitHub connection was established.
  if (!code && !state && !denied) return finish(urls.origin, "invalid_callback");

  const expected = req.cookies.get("matrix_github_oauth")?.value ?? "";
  if (!state || !expected || !sameState(expected, state)) return finish(urls.origin, "invalid-state");
  const destination = githubReturnPath(req.cookies.get("matrix_github_oauth_return")?.value);
  if (denied) return finish(urls.origin, "denied", destination);
  if (!code) return finish(urls.origin, "invalid_callback", destination);

  const user = await getSessionUser();
  if (!user) {
    const response = NextResponse.redirect(new URL("/login?next=/chat?mode=agent", urls.origin), 303);
    for (const name of ["matrix_github_oauth", "matrix_github_oauth_return", "matrix_github_oauth_owner"]) response.cookies.set(name, "", { maxAge: 0, path: "/api/github/callback" });
    return response;
  }
  if (!isGithubConfigured()) return finish(urls.origin, "not-configured", destination);
  const ownerBinding = req.cookies.get("matrix_github_oauth_owner")?.value ?? "";
  if (!ownerBinding || !sameState(ownerBinding, githubOwnerBinding(state, user.uid, env.github.tokenEncryptionKey))) {
    return finish(urls.origin, "invalid-state", destination);
  }

  try {
    const exchange = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.github.clientId,
        client_secret: env.github.clientSecret,
        code,
        redirect_uri: urls.callback,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData = (await exchange.json()) as { access_token?: string; error?: string };
    if (!exchange.ok || !tokenData.access_token || tokenData.error) return finish(urls.origin, "denied", destination);

    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenData.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MATRIX-AI-Agent",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileResponse.ok) return finish(urls.origin, "profile-failed", destination);
    const profile = (await profileResponse.json()) as { login?: string; name?: string | null; avatar_url?: string | null };
    if (!profile.login) return finish(urls.origin, "profile-failed", destination);

    await saveGithubConnection(user.uid, tokenData.access_token, {
      login: profile.login,
      name: profile.name,
      avatar_url: profile.avatar_url,
    });
    return finish(urls.origin, "connected", destination);
  } catch {
    // Never log OAuth codes or access tokens.
    console.error("[MATRIX] GitHub OAuth callback failed during exchange or persistence.");
    return finish(urls.origin, "failed", destination);
  }
}
