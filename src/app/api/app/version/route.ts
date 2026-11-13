import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { evaluateAppUpdate, getAppReleaseConfig, type AppPlatform } from "@/lib/server/app-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store, max-age=0",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rawPlatform = (url.searchParams.get("platform") ?? "android").trim().toLowerCase();
  const platform: AppPlatform = rawPlatform === "web" ? "web" : rawPlatform === "desktop" ? "desktop" : "android";
  const currentVersion = url.searchParams.get("current_version") ?? url.searchParams.get("version");
  const buildParam = url.searchParams.get("build");
  const currentBuild = buildParam ? Number.parseInt(buildParam, 10) : null;

  let d = null;
  try {
    d = adminDb();
  } catch {
    d = null;
  }

  const release = await getAppReleaseConfig(d);
  const evaluation = evaluateAppUpdate(release, {
    platform,
    currentVersion,
    currentBuild: Number.isFinite(currentBuild) ? currentBuild : null,
  });

  return NextResponse.json(evaluation, { status: 200, headers: CORS_HEADERS });
}
