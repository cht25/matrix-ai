// POST /api/auth/session — exchange a fresh Firebase ID token for a signed
// httpOnly session cookie (SSR), provisioning profile/settings docs on first
// sign-in (the port of the handle_new_user trigger). Idempotent + safe to
// call on every page load.
// DELETE /api/auth/session — clear the cookie (sign-out).

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { createSessionCookie, SESSION_COOKIE, sessionCookieOptions } from "@/lib/firebase/session";
import { ensureUserDocuments, profileOnboardingComplete } from "@/lib/server/rpc";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  let idToken: string | undefined;
  try {
    ({ idToken } = (await req.json().catch(() => ({}))) as { idToken?: string });
  } catch {
    /* fallthrough */
  }
  if (!idToken) {
    return NextResponse.json({ error: { code: "ID_TOKEN_REQUIRED", message: "idToken is required." } }, { status: 400 });
  }

  let decoded: Awaited<ReturnType<ReturnType<typeof adminAuth>["verifyIdToken"]>>;
  try {
    decoded = await adminAuth().verifyIdToken(idToken, true);
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_TOKEN", message: "The Firebase ID token is invalid or expired; sign in again." } },
      { status: 401 },
    );
  }

  try {
    const cookie = await createSessionCookie(idToken);
    let onboardingComplete = false;
    try {
      const d = adminDb();
      await ensureUserDocuments(adminAuth(), d, decoded.uid, decoded.email ?? null, decoded.name as string | undefined);
      onboardingComplete = await profileOnboardingComplete(d, decoded.uid);
    } catch (provisionErr) {
      console.error("[QORVYNA] ensureUserDocuments failed", provisionErr);
    }
    const res = NextResponse.json({ ok: true, uid: decoded.uid, onboarding_complete: onboardingComplete });
    res.cookies.set(SESSION_COOKIE, cookie, sessionCookieOptions(req));
    return res;
  } catch (err) {
    // Admin SDK needs the service account; the browser has already signed in,
    // so this is a deployment problem, not a user error.
    console.error("[QORVYNA] session cookie mint failed", err);
    return NextResponse.json(
      {
        error: {
          code: "SESSION_MINT_FAILED",
          message:
            "The server could not create the session cookie. Check FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY on the host.",
        },
      },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
