"use client";

// Shared Google / Facebook sign-in for /login and /register.
// Auth success and session-cookie success are reported separately so a
// minted Firebase user is never labelled "Google failed".

import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  getAdditionalUserInfo,
  getRedirectResult,
  linkWithPopup,
  signInWithPopup,
  signInWithRedirect,
  type AuthProvider,
  type UserCredential,
} from "firebase/auth";
import { fbAuth } from "@/lib/firebase/client";
import { describeAuthError } from "@/lib/firebase/auth-errors";
import { mintSessionCookie, RpcCallError } from "@/lib/client/api";
import { postAuthDestination } from "@/lib/routing";

export type OAuthProviderId = "google" | "facebook";

export type OAuthOk = {
  status: "ok";
  uid: string;
  onboardingComplete: boolean;
  provider: OAuthProviderId;
  isNewUser: boolean;
};

export type OAuthResult =
  | OAuthOk
  | { status: "cancelled" }
  | { status: "redirecting" }
  | { status: "session-failed"; message: string; provider: OAuthProviderId }
  | { status: "error"; message: string };

const SESSION_FAILED =
  "Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.";

export function isOAuthCancelled(err: unknown): boolean {
  const code = errorCode(err);
  return code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request";
}

export function needsOAuthRedirect(err: unknown): boolean {
  const code = errorCode(err);
  const text = errorText(err);
  return (
    code === "auth/popup-blocked" ||
    code === "auth/operation-not-supported-in-this-environment" ||
    text.includes("cross-origin-opener-policy") ||
    text.includes("coop")
  );
}

export function describeOAuthFailure(err: unknown, provider: OAuthProviderId): string {
  const code = errorCode(err);
  if (code === "auth/account-exists-with-different-credential") {
    return "An account with this email already exists. Sign in with email and password, then link Google or Facebook in Settings.";
  }
  if (code === "SESSION_MINT_FAILED" || code === "INTERNAL" || (err instanceof RpcCallError && err.status >= 500)) {
    return SESSION_FAILED;
  }
  const mapped = describeAuthError(err, "");
  if (mapped) return mapped;
  const label = provider === "google" ? "Google" : "Facebook";
  return `We couldn't finish ${label} sign-in. Please try again or use email instead.`;
}

export function postAuthPath(_onboardingComplete: boolean, next?: string | null): string {
  return postAuthDestination(next);
}

export async function completeAuthenticatedSession(): Promise<{ uid: string; onboardingComplete: boolean }> {
  const data = await mintSessionCookie();
  try {
    await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "record_security_event", event_type: "login", metadata: {} }),
    });
  } catch {
    /* best-effort */
  }
  return { uid: data.uid, onboardingComplete: data.onboarding_complete };
}

export async function signInWithOAuth(provider: OAuthProviderId): Promise<OAuthResult> {
  const auth = fbAuth();
  const providerObj = makeProvider(provider);
  try {
    const cred = await signInWithPopup(auth, providerObj);
    return await finishCredential(cred, provider);
  } catch (err) {
    if (isOAuthCancelled(err)) return { status: "cancelled" };
    if (needsOAuthRedirect(err)) {
      try {
        await signInWithRedirect(auth, providerObj);
        return { status: "redirecting" };
      } catch (redirectErr) {
        if (isOAuthCancelled(redirectErr)) return { status: "cancelled" };
        return { status: "error", message: describeOAuthFailure(redirectErr, provider) };
      }
    }
    if (isSessionFailure(err)) {
      return { status: "session-failed", message: SESSION_FAILED, provider };
    }
    return { status: "error", message: describeOAuthFailure(err, provider) };
  }
}

export async function consumeOAuthRedirect(): Promise<OAuthResult | null> {
  try {
    const cred = await getRedirectResult(fbAuth());
    if (!cred) return null;
    const provider: OAuthProviderId = cred.providerId?.includes("facebook") ? "facebook" : "google";
    return await finishCredential(cred, provider);
  } catch (err) {
    if (isOAuthCancelled(err)) return { status: "cancelled" };
    const provider: OAuthProviderId = errorText(err).includes("facebook") ? "facebook" : "google";
    if (isSessionFailure(err)) {
      return { status: "session-failed", message: SESSION_FAILED, provider };
    }
    return { status: "error", message: describeOAuthFailure(err, provider) };
  }
}

export async function linkOAuthProvider(provider: OAuthProviderId): Promise<{ ok: true } | { ok: false; message: string }> {
  const user = fbAuth().currentUser;
  if (!user) return { ok: false, message: "Sign in first, then link this provider." };
  try {
    await linkWithPopup(user, makeProvider(provider));
    await mintSessionCookie().catch(() => {});
    return { ok: true };
  } catch (err) {
    if (isOAuthCancelled(err)) return { ok: false, message: "" };
    return { ok: false, message: describeOAuthFailure(err, provider) };
  }
}

function makeProvider(provider: OAuthProviderId): AuthProvider {
  if (provider === "google") {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    p.addScope("email");
    p.addScope("profile");
    return p;
  }
  const p = new FacebookAuthProvider();
  p.addScope("email");
  p.addScope("public_profile");
  return p;
}

async function finishCredential(cred: UserCredential, provider: OAuthProviderId): Promise<OAuthResult> {
  try {
    const session = await completeAuthenticatedSession();
    const extra = getAdditionalUserInfo(cred);
    return {
      status: "ok",
      uid: session.uid,
      onboardingComplete: session.onboardingComplete,
      provider,
      isNewUser: extra?.isNewUser === true,
    };
  } catch (err) {
    if (isSessionFailure(err)) {
      return { status: "session-failed", message: SESSION_FAILED, provider };
    }
    return { status: "error", message: describeOAuthFailure(err, provider) };
  }
}

function isSessionFailure(err: unknown): boolean {
  if (err instanceof RpcCallError) {
    return err.code === "SESSION_MINT_FAILED" || err.code === "INTERNAL" || err.status >= 500;
  }
  const code = errorCode(err);
  return code === "SESSION_MINT_FAILED" || code === "INTERNAL";
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  return String((err as { code?: unknown }).code ?? "");
}

function errorText(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as { code?: unknown; message?: unknown };
  return `${e.code ?? ""} ${e.message ?? ""}`.toLowerCase();
}
