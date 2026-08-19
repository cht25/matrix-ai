import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { env, isGithubConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/chat?mode=agent", req.url));
  if (!isGithubConfigured()) {
    return NextResponse.redirect(new URL("/chat?mode=agent&github=not-configured", req.url));
  }

  const state = randomBytes(24).toString("base64url");
  const callback = env.github.callbackUrl || new URL("/api/github/callback", req.url).toString();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.github.clientId);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("scope", "read:user user:email repo");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "true");

  const response = NextResponse.redirect(authorize);
  response.cookies.set("matrix_github_oauth", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    maxAge: 10 * 60,
    path: "/api/github/callback",
  });
  return response;
}
