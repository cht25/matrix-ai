// POST /api/auth/session — exchange a fresh Firebase ID token for a signed
// httpOnly session cookie (SSR), provisioning profile/settings docs on first
// sign-in (the port of the handle_new_user trigger). Idempotent + safe to
// call on every page load.
// DELETE /api/auth/session — clear the cookie (sign-out).

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { createSessionCookie, SESSION_COOKIE, sessionCookieOptions } from "@/lib/firebase/session";
import { ensureUserDocuments, profileOnboardingComplete } from "@/lib/server/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let idToken: string | undefined;
  try {
    ({ idToken } = (await req.json().catch(() => ({}))) as { idToken?: string });
  } catch {
    /* fallthrough */
  }
  if (!idToken) return NextResponse.json({ error: "ID_TOKEN_REQUIRED" }, { status: 400 });

  let decoded: Awaited<ReturnType<ReturnType<typeof adminAuth>["verifyIdToken"]>>;
  try {
    decoded = await adminAuth().verifyIdToken(idToken, true);
  } catch {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 401 });
  }

  try {
    const cookie = await createSessionCookie(idToken);
    let onboardingComplete = false;
    try {
      const d = adminDb();
      await ensureUserDocuments(adminAuth(), d, decoded.uid, decoded.email ?? null, decoded.name as string | undefined);
      onboardingComplete = await profileOnboardingComplete(d, decoded.uid);
    } catch (provisionErr) {
      console.error("[MATRIX] ensureUserDocuments failed", provisionErr);
    }
    const res = NextResponse.json({ ok: true, uid: decoded.uid, onboarding_complete: onboardingComplete });
    res.cookies.set(SESSION_COOKIE, cookie, sessionCookieOptions(req));
    return res;
  } catch (err) {
    console.error("[MATRIX] session cookie mint failed", err);
    return NextResponse.json({ error: "SESSION_MINT_FAILED" }, { status: 500 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
