// POST /api/auth/session — exchange a fresh Firebase ID token for a signed
// httpOnly session cookie (SSR), provisioning profile/settings docs on first
// sign-in (the port of the handle_new_user trigger). Idempotent + safe to
// call on every page load.
// DELETE /api/auth/session — clear the cookie (sign-out).

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { createSessionCookie, SESSION_COOKIE, sessionCookieOptions, verifySession } from "@/lib/firebase/session";
import { ensureUserDocuments, profileOnboardingComplete } from "@/lib/server/rpc";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
} as const;

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function readProfileSummary(
  d: ReturnType<typeof adminDb>,
  uid: string,
  fallbackEmail: string | null,
) {
  const snap = await d.collection("profiles").doc(uid).get();
  const data = snap.data();
  return {
    uid,
    email: typeof data?.email === "string" && data.email ? data.email : fallbackEmail,
    full_name: typeof data?.full_name === "string" ? data.full_name : "",
    avatar_url: typeof data?.avatar_url === "string" ? data.avatar_url : "",
  };
}

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
    return noStoreJson({ error: { code: "ID_TOKEN_REQUIRED", message: "idToken is required." } }, 400);
  }

  let decoded: Awaited<ReturnType<ReturnType<typeof adminAuth>["verifyIdToken"]>>;
  try {
    decoded = await adminAuth().verifyIdToken(idToken, true);
  } catch {
    return noStoreJson(
      { error: { code: "INVALID_TOKEN", message: "The Firebase ID token is invalid or expired; sign in again." } },
      401,
    );
  }

  try {
    const cookie = await createSessionCookie(idToken);
    let onboardingComplete = false;
    let profileLoaded = true;
    let profileError: string | undefined;
    let profile: { uid: string; email: string | null; full_name: string; avatar_url: string } | null = null;
    try {
      const d = adminDb();
      await ensureUserDocuments(adminAuth(), d, decoded.uid, decoded.email ?? null, decoded.name as string | undefined);
      onboardingComplete = await profileOnboardingComplete(d, decoded.uid);
      profile = await readProfileSummary(d, decoded.uid, decoded.email ?? null);
    } catch (provisionErr) {
      profileLoaded = false;
      profileError = "PROFILE_PROVISION_FAILED";
      console.error("[QORVYNA] ensureUserDocuments failed", provisionErr);
    }
    const res = noStoreJson({
      ok: true,
      uid: decoded.uid,
      onboarding_complete: onboardingComplete,
      profile_loaded: profileLoaded,
      ...(profileError ? { profile_error: profileError } : {}),
      profile,
    });
    res.cookies.set(SESSION_COOKIE, cookie, sessionCookieOptions(req));
    return res;
  } catch (err) {
    // Admin SDK needs the service account; the browser has already signed in,
    // so this is a deployment problem, not a user error.
    console.error("[QORVYNA] session cookie mint failed", err);
    return noStoreJson(
      {
        error: {
          code: "SESSION_MINT_FAILED",
          message:
            "The server could not create the session cookie. Check FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY on the host.",
        },
      },
      500,
    );
  }
}

/**
 * GET /api/auth/session — read-only session probe for the client auth
 * lifecycle (src/lib/auth/lifecycle.ts). Answers whether the caller's
 * httpOnly cookie is currently valid so the browser can tell
 * "session already established" from "needs a mint" WITHOUT refreshing a
 * token or creating a second session. Never returns secrets.
 */
export async function GET(req: NextRequest) {
  const cookieValue = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookieValue) return noStoreJson({ authenticated: false });
  try {
    const user = await verifySession(cookieValue);
    let onboardingComplete = false;
    let profileLoaded = true;
    let profileError: string | undefined;
    let profile: { uid: string; email: string | null; full_name: string; avatar_url: string } | null = null;
    try {
      const d = adminDb();
      onboardingComplete = await profileOnboardingComplete(d, user.uid);
      profile = await readProfileSummary(d, user.uid, user.email);
    } catch (profileErr) {
      profileLoaded = false;
      profileError = "PROFILE_LOAD_FAILED";
      console.error("[QORVYNA] GET /api/auth/session profile load failed", profileErr);
    }
    return noStoreJson({
      authenticated: true,
      uid: user.uid,
      onboarding_complete: onboardingComplete,
      profile_loaded: profileLoaded,
      ...(profileError ? { profile_error: profileError } : {}),
      profile,
    });
  } catch {
    // Invalid/expired/revoked cookie: the client mints a fresh one when it
    // holds a Firebase user, or treats the visitor as signed out.
    return noStoreJson({ authenticated: false });
  }
}

export async function DELETE(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const res = noStoreJson({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
