"use client";

// =============================================================================
// Google / Facebook sign-in for /login and /register.
//
// TRANSPORT: full-page redirect only.
//   startOAuthSignIn()  → signInWithRedirect(auth, provider)
//   consumeOAuthRedirect() → getRedirectResult(auth), once per page load
//
// The popup transport was removed on purpose. It cannot complete on every
// browser/profile (popup blockers, cross-origin-opener-policy, storage
// partitioning, iOS/Android WebViews) and its failure mode is a generic "we
// couldn't finish" message after the user already picked an account. A
// top-level redirect is Firebase's own recommendation for those environments
// and it is what mobile Chrome needs.
//
// Two separate things are reported separately, always:
//   • the Firebase/Google step  → status "cancelled" | "error" | "redirecting"
//   • the QORVYNA session step  → status "session-failed"
// A minted Firebase user is NEVER labelled "Google failed".
// =============================================================================

import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  getAdditionalUserInfo,
  getRedirectResult,
  linkWithRedirect,
  signInWithRedirect,
  type AuthProvider,
  type UserCredential,
} from "firebase/auth";
import { fbAuth } from "@/lib/firebase/client";
import { describeAuthError } from "@/lib/firebase/auth-errors";
import { mintSessionCookie } from "@/lib/client/api";
import { postAuthDestination } from "@/lib/routing";
import { logAuthDiagnostic } from "@/lib/auth/diagnostics";

export type OAuthProviderId = "google" | "facebook";

export type OAuthOk = {
  status: "ok";
  uid: string;
  onboardingComplete: boolean;
  provider: OAuthProviderId;
  isNewUser: boolean;
  /**
   * "link" means an already signed-in user attached a provider (Settings →
   * Linked sign-in). It must never trigger a post-login navigation.
   */
  operation: "signIn" | "link";
};

export type OAuthResult =
  | OAuthOk
  | { status: "cancelled" }
  | { status: "redirecting" }
  | { status: "session-failed"; message: string; provider: OAuthProviderId }
  | { status: "error"; message: string; provider?: OAuthProviderId };

const SESSION_FAILED =
  "Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.";

const BAD_ORIGIN_FAILED =
  "You're signed in, but this domain is not allowed to create the QORVYNA session. An administrator must include this hostname in NEXT_PUBLIC_APP_URL (or QORVYNA_ALLOWED_ORIGINS) and redeploy — your account is fine.";

// -----------------------------------------------------------------------------
// Storage keys. All access is guarded: a browser with storage blocked still
// gets a working sign-in, it just loses the "remembered destination" nicety.
// -----------------------------------------------------------------------------

const K_NEXT = "qorvyna.oauth.next";
const K_PENDING_REDIRECT = "qorvyna.oauth.pending-redirect";
const K_PENDING_LINK = "qorvyna.oauth.pending-link";
const K_NOTICE = "qorvyna.oauth.notice";

/** A marker older than this is stale (abandoned tab) and must not block the UI. */
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

function store(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled — the flow continues without the hint */
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

// -----------------------------------------------------------------------------
// Post-login destination
// -----------------------------------------------------------------------------

/**
 * Remember where the visitor wanted to land. Survives the round-trip to Google
 * and any reload in between; the URL's own `?next=` is still preferred when
 * present because it is what the visitor can see.
 */
export function rememberPostLoginPath(next: string | null | undefined): void {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return;
  writeJson(K_NEXT, { path: next, at: Date.now() });
}

/** The remembered destination, or null when absent/stale. */
export function rememberedPostLoginPath(): string | null {
  const saved = readJson<{ path?: unknown; at?: unknown }>(K_NEXT);
  if (!saved || typeof saved.path !== "string" || typeof saved.at !== "number") return null;
  if (Date.now() - saved.at > PENDING_MAX_AGE_MS) {
    remove(K_NEXT);
    return null;
  }
  return saved.path.startsWith("/") && !saved.path.startsWith("//") ? saved.path : null;
}

function clearRememberedPostLoginPath(): void {
  remove(K_NEXT);
}

/** Resolve the destination for a completed sign-in. */
export function postAuthPath(onboardingComplete: boolean, next?: string | null): string {
  return postAuthDestination(next ?? rememberedPostLoginPath());
}

// -----------------------------------------------------------------------------
// Pending-redirect bookkeeping (drives the loading state and loop protection)
// -----------------------------------------------------------------------------

function markRedirectPending(provider: OAuthProviderId): void {
  writeJson(K_PENDING_REDIRECT, { provider, at: Date.now() });
}

/** True while a redirect we started may still be in flight. */
export function oauthRedirectPending(): boolean {
  const pending = readJson<{ at?: unknown }>(K_PENDING_REDIRECT);
  if (!pending || typeof pending.at !== "number") return false;
  if (Date.now() - pending.at > PENDING_MAX_AGE_MS) {
    remove(K_PENDING_REDIRECT);
    return false;
  }
  return true;
}

function clearRedirectPending(): void {
  remove(K_PENDING_REDIRECT);
}

/** Set by Settings → Linked sign-in before leaving for Google. */
export function pendingLinkProvider(): OAuthProviderId | null {
  const value = readJson<{ provider?: unknown; at?: unknown }>(K_PENDING_LINK);
  if (!value || typeof value.at !== "number" || typeof value.provider !== "string") return null;
  if (Date.now() - value.at > PENDING_MAX_AGE_MS) {
    remove(K_PENDING_LINK);
    return null;
  }
  return value.provider === "facebook" ? "facebook" : "google";
}

function clearPendingLink(): void {
  remove(K_PENDING_LINK);
}

/** One-shot message for the screen that resumes after a redirect. */
export function setOAuthNotice(message: string, tone: "success" | "danger"): void {
  writeJson(K_NOTICE, { message, tone, at: Date.now() });
}

export function consumeOAuthNotice(): { message: string; tone: "success" | "danger" } | null {
  const notice = readJson<{ message?: unknown; tone?: unknown; at?: unknown }>(K_NOTICE);
  remove(K_NOTICE);
  if (!notice || typeof notice.message !== "string") return null;
  const tone = notice.tone === "success" ? "success" : "danger";
  return { message: notice.message, tone };
}

// -----------------------------------------------------------------------------
// Error classification
// -----------------------------------------------------------------------------

const CANCELLED_CODES = new Set([
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/user-cancelled",
  "auth/redirect-cancelled-by-user",
  "auth/web-context-cancelled",
]);

/** The user closed/chose not to continue — not an error worth shouting about. */
export function isOAuthCancelled(err: unknown): boolean {
  return CANCELLED_CODES.has(errorCode(err));
}

/** No redirect was in flight: `getRedirectResult` resolved nothing. */
function isNoAuthEvent(err: unknown): boolean {
  const code = errorCode(err);
  return code === "auth/no-auth-event" || code === "auth/argument-error";
}

/** Storage/cookies blocked by the browser: sign-in genuinely cannot proceed. */
function isStorageBlocked(err: unknown): boolean {
  const code = errorCode(err);
  const text = errorText(err);
  return (
    code === "auth/web-storage-unsupported" ||
    code === "auth/third-party-cookie-blocked" ||
    text.includes("storage-partitioned") ||
    text.includes("cookie")
  );
}

export function describeOAuthFailure(err: unknown, provider: OAuthProviderId): string {
  const code = errorCode(err);
  const label = provider === "google" ? "Google" : "Facebook";

  if (code === "BAD_ORIGIN") return BAD_ORIGIN_FAILED;
  if (code === "auth/account-exists-with-different-credential") {
    return "An account with this email already exists. Sign in with email and password, then link Google or Facebook in Settings.";
  }
  if (isStorageBlocked(err)) {
    return "Your browser blocked the storage this sign-in needs. Allow cookies/site data for this domain (or leave private browsing) and try again.";
  }
  if (code === "auth/operation-not-supported-in-this-environment") {
    return `${label} sign-in can't run inside this in-app browser. Open QORVYNA in Chrome/Safari, or sign in with email instead.`;
  }
  if (code === "auth/unauthorized-domain") {
    return "Server setup problem — this domain isn't approved for sign-in yet (Firebase console → Authentication → Settings → Authorized domains).";
  }
  if (code === "auth/operation-not-allowed") {
    return "Server setup problem — this sign-in method isn't enabled in Firebase (console → Authentication → Sign-in method).";
  }
  const mapped = describeAuthError(err, "");
  if (mapped) return mapped;
  return `We couldn't finish ${label} sign-in. Please try again or use email instead.`;
}

// -----------------------------------------------------------------------------
// Session establishment
// -----------------------------------------------------------------------------

/** Exchange the signed-in user's ID token for the httpOnly `__session` cookie. */
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
    /* best-effort audit only */
  }
  return { uid: data.uid, onboardingComplete: data.onboarding_complete };
}

function sessionFailureResult(err: unknown, provider: OAuthProviderId): OAuthResult {
  const code = errorCode(err);
  const message = code === "BAD_ORIGIN" ? BAD_ORIGIN_FAILED : SESSION_FAILED;
  logAuthDiagnostic({ stage: "session-mint", method: provider, provider, error: err, detail: { code } });
  return { status: "session-failed", message, provider };
}

// -----------------------------------------------------------------------------
// Public flows
// -----------------------------------------------------------------------------

function makeProvider(provider: OAuthProviderId): AuthProvider {
  if (provider === "google") {
    const p = new GoogleAuthProvider();
    // Always show the account chooser: on a migrated domain the browser may
    // still hold the old session hint, and "silently reuse the last account"
    // is how people end up in the wrong profile.
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

/**
 * Begin a full-page redirect to the provider's consent screen.
 * Returns `{status:"redirecting"}` in the normal case (the page is unloading).
 */
export async function startOAuthSignIn(
  provider: OAuthProviderId,
  options: { next?: string | null } = {},
): Promise<OAuthResult> {
  const auth = fbAuth();
  rememberPostLoginPath(options.next);
  markRedirectPending(provider);
  logAuthDiagnostic({
    stage: "redirect-start",
    method: "redirect",
    provider,
    detail: { next: options.next ?? "" },
  });
  try {
    await signInWithRedirect(auth, makeProvider(provider));
    return { status: "redirecting" };
  } catch (err) {
    clearRedirectPending();
    logAuthDiagnostic({ stage: "redirect-start", method: "redirect", provider, error: err });
    if (isOAuthCancelled(err)) return { status: "cancelled" };
    return { status: "error", message: describeOAuthFailure(err, provider), provider };
  }
}

/**
 * Start linking a provider to the CURRENT user (Settings → Linked sign-in).
 * Same redirect transport, tagged so the return trip cannot be mistaken for a
 * fresh sign-in.
 */
export async function startOAuthLink(provider: OAuthProviderId): Promise<OAuthResult> {
  const user = fbAuth().currentUser;
  if (!user) return { status: "error", message: "Sign in first, then link this provider.", provider };
  writeJson(K_PENDING_LINK, { provider, at: Date.now() });
  markRedirectPending(provider);
  logAuthDiagnostic({ stage: "link-start", method: "link", provider });
  try {
    await linkWithRedirect(user, makeProvider(provider));
    return { status: "redirecting" };
  } catch (err) {
    clearPendingLink();
    clearRedirectPending();
    logAuthDiagnostic({ stage: "link-start", method: "link", provider, error: err });
    if (isOAuthCancelled(err)) return { status: "cancelled" };
    return { status: "error", message: describeOAuthFailure(err, provider), provider };
  }
}

/**
 * Consume the pending redirect exactly once per page load.
 *
 * `getRedirectResult()` is single-shot and several screens can mount at the
 * same time (auth pages, the app shell, /verify). Sharing one promise is what
 * prevents a double session mint — and a double navigation — from racing.
 */
let redirectConsumption: Promise<OAuthResult | null> | null = null;

export function consumeOAuthRedirect(): Promise<OAuthResult | null> {
  if (!redirectConsumption) {
    redirectConsumption = handleRedirectResult().catch((err: unknown) => {
      // Never leave a marker behind on an unexpected crash: a stuck pending
      // marker is what turns "try again" into a spinner that never resolves.
      clearPendingLink();
      clearRedirectPending();
      logAuthDiagnostic({ stage: "redirect-result", method: "redirect", error: err, detail: { crashed: true } });
      return { status: "error", message: describeOAuthFailure(err, "google") } as OAuthResult;
    });
  }
  return redirectConsumption;
}

async function handleRedirectResult(): Promise<OAuthResult | null> {
  const auth = fbAuth();
  const linkProvider = pendingLinkProvider();
  let cred: UserCredential;
  try {
    const result = await getRedirectResult(auth);
    if (!result) {
      // Nothing in flight. Drop any stale marker so the UI never hangs on a
      // spinner from an abandoned attempt.
      clearRedirectPending();
      if (linkProvider) {
        clearPendingLink();
        logAuthDiagnostic({ stage: "link-result", method: "link", provider: linkProvider, detail: { redirect: "absent" } });
        return {
          status: "error",
          message: "Linking didn't complete. Please try again from Settings.",
          provider: linkProvider,
        };
      }
      logAuthDiagnostic({ stage: "redirect-result", method: "redirect", detail: { redirect: "absent" } });
      return null;
    }
    cred = result;
  } catch (err) {
    clearRedirectPending();
    if (isNoAuthEvent(err)) return null;
    if (isOAuthCancelled(err)) {
      clearPendingLink();
      logAuthDiagnostic({ stage: "redirect-result", method: "redirect", error: err, detail: { redirect: "cancelled" } });
      return { status: "cancelled" };
    }
    const provider = linkProvider ?? providerFromError(err);
    logAuthDiagnostic({
      stage: "redirect-result",
      method: linkProvider ? "link" : "redirect",
      provider,
      error: err,
      detail: { redirect: "failed" },
    });
    clearPendingLink();
    return { status: "error", message: describeOAuthFailure(err, provider), provider };
  }

  clearRedirectPending();
  const provider = providerFromCredential(cred) ?? linkProvider ?? "google";
  logAuthDiagnostic({
    stage: linkProvider ? "link-result" : "redirect-result",
    method: linkProvider ? "link" : "redirect",
    provider,
    detail: {
      redirect: "consumed",
      operationType: cred.operationType ?? "unknown",
      hasUser: Boolean(cred.user),
    },
  });

  // Settings → Linked sign-in return trip.
  if (linkProvider) {
    clearPendingLink();
    if (cred.operationType !== "link") {
      // The browser came back signed in instead of linking. Never attach the
      // credential silently — the account that just signed in may not be the
      // account whose Settings page sent us here.
      await signOutQuietly();
      return {
        status: "error",
        message: "We couldn't link that provider to your account. Sign in with your password, then link it from Settings.",
        provider,
      };
    }
    try {
      await completeAuthenticatedSession();
    } catch {
      /* the link itself succeeded; the existing cookie is still valid */
    }
    return {
      status: "ok",
      uid: cred.user.uid,
      onboardingComplete: true,
      provider,
      isNewUser: false,
      operation: "link",
    };
  }

  return finishSignIn(cred, provider);
}

async function finishSignIn(cred: UserCredential, provider: OAuthProviderId): Promise<OAuthResult> {
  const isNewUser = (() => {
    try {
      return getAdditionalUserInfo(cred)?.isNewUser === true;
    } catch {
      return false;
    }
  })();

  try {
    const session = await completeAuthenticatedSession();
    clearRememberedPostLoginPath();
    return {
      status: "ok",
      uid: session.uid,
      onboardingComplete: session.onboardingComplete,
      provider,
      isNewUser,
      operation: "signIn",
    };
  } catch (err) {
    // The Firebase user exists (or was returned) — this is a session problem,
    // and telling the user "Google failed" would be a lie that hides a
    // deployment misconfiguration.
    return sessionFailureResult(err, provider);
  }
}

function providerFromCredential(cred: UserCredential): OAuthProviderId | null {
  const id = cred.providerId ?? cred.user?.providerData?.[0]?.providerId ?? "";
  if (id.includes("facebook")) return "facebook";
  if (id.includes("google")) return "google";
  return null;
}

function providerFromError(err: unknown): OAuthProviderId {
  return errorText(err).includes("facebook") ? "facebook" : "google";
}

async function signOutQuietly(): Promise<void> {
  try {
    const { signOut } = await import("firebase/auth");
    await signOut(fbAuth());
  } catch {
    /* ignore */
  }
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
