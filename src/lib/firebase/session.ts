// Server-side session management: Firebase Auth session cookies.
//
// The browser signs in with the Firebase client SDK, POSTs the resulting
// ID token to /api/auth/session, and the server exchanges it for a signed
// httpOnly session cookie (`__session`, 5 days). Server components and API
// routes verify that cookie with the Admin SDK — the same contract the old
// Supabase cookie sessions provided, so SSR keeps working unchanged.
//
// Middleware (edge runtime, no Admin SDK) only performs a cheap, unverified
// presence/expiry check for routing; every privileged read verifies the
// signature server-side.

import "server-only";
import { cookies } from "next/headers";
import { adminAuth, adminConfigured } from "@/lib/firebase/admin";

export const SESSION_COOKIE = "__session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5; // 5 days (Firebase max: 2 weeks)

export type SessionUser = {
  uid: string;
  email: string | null;
  emailVerified: boolean;
};

/** Exchange a fresh client ID token for a session cookie. Returns cookie options. */
export async function createSessionCookie(idToken: string): Promise<string> {
  return adminAuth().createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_SECONDS * 1000 });
}

/** Verify the session cookie → Firebase decoded claims. Throws on invalid/expired. */
export async function verifySession(cookieValue: string): Promise<SessionUser> {
  const decoded = await adminAuth().verifySessionCookie(cookieValue, true);
  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    emailVerified: decoded.email_verified ?? false,
  };
}

/** Current signed-in user for server components, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!adminConfigured()) return null;
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value) return null;
  try {
    return await verifySession(value);
  } catch {
    return null;
  }
}

/** Cookie write options shared by the mint and refresh endpoints. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
