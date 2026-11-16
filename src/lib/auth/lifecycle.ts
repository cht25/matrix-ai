"use client";

// =============================================================================
// Centralised authentication lifecycle (client).
//
// WHY THIS EXISTS
// After a full-page Google redirect the browser comes back to the site with
// THREE pieces of state that must be reconciled in a strict order:
//   1. Firebase's pending redirect result  (getRedirectResult — single-shot)
//   2. Firebase's restored currentUser     (onAuthStateChanged — fires once
//                                           after persistence is loaded)
//   3. The backend `__session` cookie      (POST /api/auth/session with the
//                                           user's ID token)
// Screens used to do this themselves, which meant a page that did NOT process
// the redirect result (or one where the result was already drained) rendered
// the plain login form while Firebase held a signed-in user and the server had
// no cookie — the visitor sat on /login forever: protected routes bounced
// them back because there was no cookie, and nothing ever completed the
// session. There was also no timeout: a hanging getRedirectResult() left the
// "Finishing sign-in…" spinner up for ever.
//
// This module owns that sequence exactly once per page load:
//
//   INITIALIZING ──► persistence ──► initial auth state ──► redirect result
//        │                                                │
//        │                          UNAUTHENTICATED ◄──────┤ (no user)
//        │                          ERROR ◄────────────────┤ (stage failed)
//        ▼                                                ▼
//   PROFILE_LOADING ◄── session established (cookie verified or minted)
//        │
//        ▼
//       READY  (only now may a guard navigate)
//
// Rules encoded here (see the task requirements):
//   • getRedirectResult() runs during application startup, before any screen
//     decides the visitor is logged out, and is the SAME memoised consumer
//     every screen uses — it can never race or be drained twice.
//   • The initial onAuthStateChanged is awaited; "still restoring" is never
//     mistaken for "logged out".
//   • Firebase Auth persistence is pinned to browserLocalPersistence (the
//     correct strategy for a browser app). Nothing clears auth state while a
//     redirect is being processed; localStorage is never used as an auth
//     source of truth (sessionStorage only carries flow markers such as the
//     remembered destination).
//   • Every stage is timed out and reported as a RECOVERABLE ERROR state —
//     never an infinite spinner.
//   • Diagnostics name each stage without ever carrying tokens or credentials.
// =============================================================================

import { browserLocalPersistence, onAuthStateChanged, setPersistence } from "firebase/auth";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import {
  completeAuthenticatedSession,
  consumeOAuthRedirect,
  oauthRedirectPending,
  type OAuthResult,
} from "@/lib/auth/oauth";
import { logAuthDiagnostic } from "@/lib/auth/diagnostics";

/** Explicit application authentication states. */
export type AuthLifecycleStatus =
  | "INITIALIZING"
  | "AUTHENTICATED"
  | "UNAUTHENTICATED"
  | "PROFILE_LOADING"
  | "READY"
  | "ERROR";

export type AuthLifecycleError = {
  /** Which stage failed — matches the diagnostic stage names. */
  stage: string;
  message: string;
};

export type AuthLifecycleUser = { uid: string; email: string | null };

export type AuthLifecycleState = {
  status: AuthLifecycleStatus;
  user: AuthLifecycleUser | null;
  onboardingComplete: boolean;
  error: AuthLifecycleError | null;
  /** A redirect we started may still be in flight (drives the copy on screen). */
  pendingRedirect: boolean;
  /** A redirect result was present on this page load. */
  redirectHandled: boolean;
};

const INITIAL_STATE_TIMEOUT_MS = 5_000;
const REDIRECT_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 15_000;

const INITIAL_STATE: AuthLifecycleState = {
  status: "INITIALIZING",
  user: null,
  onboardingComplete: false,
  error: null,
  pendingRedirect: false,
  redirectHandled: false,
};

let state: AuthLifecycleState = { ...INITIAL_STATE };
let run: Promise<AuthLifecycleState> | null = null;
let listenerAttached = false;
const listeners = new Set<(next: AuthLifecycleState) => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch {
      /* a broken subscriber must never break auth initialisation */
    }
  }
}

function setState(patch: Partial<AuthLifecycleState>): void {
  state = { ...state, ...patch };
  emit();
}

function fail(stage: string, message: string, error?: unknown): AuthLifecycleState {
  logAuthDiagnostic({ stage: "auth-init", method: "session", error, detail: { failed_stage: stage } });
  setState({ status: "ERROR", error: { stage, message } });
  return state;
}

/** Current state (also the initial value for React subscribers). */
export function getAuthLifecycleState(): AuthLifecycleState {
  return state;
}

/** Subscribe to state changes. The current state is delivered immediately. */
export function subscribeAuthLifecycle(listener: (next: AuthLifecycleState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What an auth page should do with a given state. Kept pure so the guard
 * behaviour is unit-testable: INITIALIZING is NEVER treated as logged out.
 */
export function authGuardDecision(
  status: AuthLifecycleStatus,
): "wait" | "navigate" | "form" | "error" {
  if (status === "INITIALIZING" || status === "PROFILE_LOADING") return "wait";
  if (status === "READY" || status === "AUTHENTICATED") return "navigate";
  if (status === "ERROR") return "error";
  return "form"; // UNAUTHENTICATED
}

// -----------------------------------------------------------------------------
// Stage helpers
// -----------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Wait for Firebase's FIRST auth-state callback (session restored or not). */
function waitInitialAuthState(): Promise<{ user: AuthLifecycleUser | null; timedOut: boolean }> {
  const auth = fbAuth();
  if (auth.currentUser) {
    const user = auth.currentUser;
    return Promise.resolve({ user: { uid: user.uid, email: user.email ?? null }, timedOut: false });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { user: AuthLifecycleUser | null; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ user: null, timedOut: true }), INITIAL_STATE_TIMEOUT_MS);
    const unsub = onAuthStateChanged(auth, (user) => {
      finish({ user: user ? { uid: user.uid, email: user.email ?? null } : null, timedOut: false });
    });
  });
}

type SessionStatus = { authenticated?: boolean; uid?: string; onboarding_complete?: boolean };

/** Read-only probe: does the server already accept our session cookie? */
async function fetchSessionStatus(): Promise<SessionStatus | null> {
  try {
    const res = await fetch("/api/auth/session", { method: "GET", credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SessionStatus;
  } catch {
    return null;
  }
}

/**
 * Make sure the backend session exists for the signed-in Firebase user.
 * Verifies an existing cookie first (no needless token refresh), otherwise
 * exchanges a fresh ID token for the `__session` cookie. Single-flight: a
 * concurrent caller awaits the same mint.
 */
let mintInFlight: Promise<{ uid: string; onboardingComplete: boolean }> | null = null;

async function ensureBackendSession(): Promise<{ uid: string; onboardingComplete: boolean }> {
  if (mintInFlight) return mintInFlight;
  mintInFlight = (async () => {
    const status = await withTimeout(
      fetchSessionStatus(),
      SESSION_TIMEOUT_MS,
      () => new Error("The server did not answer the session check in time."),
    );
    if (status?.authenticated) {
      logAuthDiagnostic({
        stage: "session-check",
        method: "session",
        detail: { result: "cookie-valid", uid_present: Boolean(status.uid) },
      });
      return { uid: status.uid ?? "", onboardingComplete: status.onboarding_complete === true };
    }
    // No usable cookie: obtain + validate the Firebase ID token and mint one.
    logAuthDiagnostic({ stage: "id-token", method: "session", detail: { step: "retrieve-and-validate" } });
    const session = await withTimeout(
      completeAuthenticatedSession(),
      SESSION_TIMEOUT_MS,
      () => new Error("The server did not create your session in time."),
    );
    logAuthDiagnostic({
      stage: "session-mint",
      method: "session",
      detail: { result: "minted", onboarding_complete: session.onboardingComplete },
    });
    return session;
  })().finally(() => {
    mintInFlight = null;
  });
  return mintInFlight;
}

// -----------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------

async function runLifecycle(): Promise<AuthLifecycleState> {
  const pendingRedirect = oauthRedirectPending();
  setState({ status: "INITIALIZING", error: null, pendingRedirect, redirectHandled: false });

  if (!firebaseBrowserConfigured) {
    return fail(
      "auth-init",
      "QORVYNA is not connected to its backend services yet, so authentication is unavailable. The administrator must set the NEXT_PUBLIC_FIREBASE_* variables and redeploy.",
    );
  }

  const auth = fbAuth();

  // 1. Pin persistence. browserLocalPersistence is the correct strategy for a
  //    browser app: the session must survive refreshes and the redirect return
  //    trip. Failure here is logged but never fatal — the SDK default on the
  //    web is already local persistence.
  try {
    await withTimeout(
      setPersistence(auth, browserLocalPersistence),
      5_000,
      () => new Error("persistence setup timed out"),
    );
    logAuthDiagnostic({ stage: "persistence", method: "session", detail: { strategy: "browserLocalPersistence" } });
  } catch (error) {
    logAuthDiagnostic({
      stage: "persistence",
      method: "session",
      error,
      detail: { strategy: "browserLocalPersistence", note: "kept SDK default" },
    });
  }

  // 2. Wait for Firebase's initial authentication state. Never decide
  //    "logged out" while the SDK is still restoring a persisted session.
  const initial = await waitInitialAuthState().catch((error: unknown) => {
    logAuthDiagnostic({ stage: "auth-state", method: "session", error });
    return { user: null, timedOut: true };
  });
  logAuthDiagnostic({
    stage: "auth-state",
    method: "session",
    detail: { user_present: Boolean(initial.user), timed_out: initial.timedOut },
  });
  if (initial.timedOut && !fbAuth().currentUser) {
    return fail(
      "auth-state",
      "Firebase did not finish restoring your session. Check your connection and tap Retry — you will not be signed out.",
    );
  }
  const user: AuthLifecycleUser | null =
    initial.user ??
    (fbAuth().currentUser
      ? { uid: fbAuth().currentUser!.uid, email: fbAuth().currentUser!.email ?? null }
      : null);

  // 3. The redirect result — the single memoised consumer shared with the
  //    auth screens and /verify, so it can never be processed twice or race
  //    another screen. Timed out instead of hanging for ever.
  let redirect: OAuthResult | null = null;
  try {
    redirect = await withTimeout(
      consumeOAuthRedirect(),
      REDIRECT_TIMEOUT_MS,
      () => new Error("The sign-in return trip did not complete in time."),
    );
    setState({ redirectHandled: redirect !== null });
    logAuthDiagnostic({
      stage: "redirect-result",
      method: "redirect",
      detail: { redirect: redirect ? redirect.status : "absent" },
    });
  } catch (error) {
    return fail(
      "redirect-result",
      "The sign-in return trip did not complete. Tap Retry to finish signing in — you will not create a second account.",
      error,
    );
  }

  if (redirect) {
    if (redirect.status === "session-failed") {
      return fail("session-mint", redirect.message);
    }
    if (redirect.status === "error") {
      return fail("redirect-result", redirect.message);
    }
    if (redirect.status === "ok" && redirect.operation === "signIn") {
      // finishSignIn() already minted the backend session for this credential.
      logAuthDiagnostic({
        stage: "profile",
        method: "session",
        provider: redirect.provider,
        detail: { ensured_by: "session-mint", new_user: redirect.isNewUser },
      });
      setState({
        status: "READY",
        user: { uid: redirect.uid, email: user?.email ?? null },
        onboardingComplete: redirect.onboardingComplete,
        error: null,
        pendingRedirect: false,
      });
      return state;
    }
    // "cancelled" or an account-link return: fall through to the session
    // check below with whatever Firebase has now.
  }

  const currentUser = fbAuth().currentUser;
  const effectiveUser: AuthLifecycleUser | null = user ?? (currentUser ? { uid: currentUser.uid, email: currentUser.email ?? null } : null);

  // 4. Backend session. With a Firebase user we always verify the cookie
  //    first and mint only when it is missing/invalid — this is what repairs
  //    the "returned to /login with no session" state.
  if (effectiveUser) {
    setState({ status: "PROFILE_LOADING" });
    try {
      const session = await ensureBackendSession();
      logAuthDiagnostic({
        stage: "profile",
        method: "session",
        detail: { ensured_by: session.uid ? "session-mint-or-cookie" : "unknown", onboarding_complete: session.onboardingComplete },
      });
      setState({
        status: "READY",
        user: { uid: session.uid || effectiveUser.uid, email: effectiveUser.email },
        onboardingComplete: session.onboardingComplete,
        error: null,
        pendingRedirect: false,
      });
      return state;
    } catch (error) {
      return fail(
        "session-mint",
        "Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.",
        error,
      );
    }
  }

  // 5. No Firebase user after the initial state AND no redirect result: this
  //    is a genuine signed-out visitor.
  logAuthDiagnostic({ stage: "auth-state", method: "session", detail: { decision: "unauthenticated" } });
  setState({ status: "UNAUTHENTICATED", user: null, onboardingComplete: false, error: null, pendingRedirect: false });
  return state;
}

function attachStateMirror(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  // Mirror Firebase's ongoing state so a sign-out in this tab immediately
  // returns auth pages to the form instead of bouncing back into the app.
  // The listener only ever DEGRADES the status (never upgrades it): status
  // upgrades happen exclusively after a confirmed backend session.
  try {
    onAuthStateChanged(fbAuth(), (user) => {
      if (!user && (state.status === "READY" || state.status === "AUTHENTICATED" || state.status === "PROFILE_LOADING")) {
        logAuthDiagnostic({ stage: "auth-state", method: "session", detail: { decision: "signed-out" } });
        setState({ status: "UNAUTHENTICATED", user: null, onboardingComplete: false });
      } else if (user && state.user?.uid !== user.uid) {
        setState({ user: { uid: user.uid, email: user.email ?? null } });
      }
    });
  } catch {
    /* never fatal */
  }
}

/** Start (or await) the once-per-page-load lifecycle. */
export function startAuthLifecycle(): Promise<AuthLifecycleState> {
  if (!run) {
    attachStateMirror();
    run = runLifecycle().catch((error: unknown) => fail("auth-init", "Authentication could not be initialised. Tap Retry.", error));
  }
  return run;
}

/** Recoverable retry: re-runs the whole sequence from INITIALIZING. */
export function retryAuthLifecycle(): Promise<AuthLifecycleState> {
  run = null;
  mintInFlight = null;
  return startAuthLifecycle();
}

// -----------------------------------------------------------------------------
// Redirect-loop protection
// -----------------------------------------------------------------------------
// A session that the client believes is established but the server rejects
// would otherwise bounce /chat → /login → mint → /chat for ever. Every
// login→app navigation records an attempt here; past a small limit within a
// short window the UI STOPS navigating and shows a recoverable error instead.
// The counter only ever blocks automatic navigation — a human pressing Retry
// clears it deliberately.

const K_NAV_ATTEMPTS = "qorvyna.auth.nav-attempts";
const NAV_WINDOW_MS = 120_000;
const MAX_NAV_ATTEMPTS = 2;

/**
 * Record a login→app navigation attempt.
 * Returns false when a redirect loop is detected (caller must stop and show
 * an error instead of navigating).
 */
export function recordPostLoginNavigation(): boolean {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return true;
    const now = Date.now();
    let attempts = 1;
    let windowStart = now;
    try {
      const raw = window.sessionStorage.getItem(K_NAV_ATTEMPTS);
      const parsed = raw ? (JSON.parse(raw) as { at?: number; count?: number }) : null;
      if (parsed && typeof parsed.at === "number" && typeof parsed.count === "number" && now - parsed.at < NAV_WINDOW_MS) {
        windowStart = parsed.at;
        attempts = parsed.count + 1;
      }
    } catch {
      /* unreadable marker — start a fresh window */
    }
    window.sessionStorage.setItem(K_NAV_ATTEMPTS, JSON.stringify({ at: windowStart, count: attempts }));
    if (attempts > MAX_NAV_ATTEMPTS) {
      logAuthDiagnostic({ stage: "navigation", method: "session", detail: { result: "loop-detected", attempts } });
      return false;
    }
    return true;
  } catch {
    return true; // storage blocked: never trap the user behind a dead guard
  }
}

/** Clear the loop counter (explicit user action: "Try again"). */
export function resetPostLoginNavigationGuard(): void {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    window.sessionStorage.removeItem(K_NAV_ATTEMPTS);
  } catch {
    /* ignore */
  }
}

/**
 * Called by a screen that just established the backend session itself
 * (password / MFA sign-in) so the shared state reflects reality before the
 * screen navigates.
 */
export function markSessionEstablished(input: { uid: string; onboardingComplete: boolean }): void {
  setState({
    status: "READY",
    user: { uid: input.uid, email: state.user?.email ?? fbAuth().currentUser?.email ?? null },
    onboardingComplete: input.onboardingComplete,
    error: null,
    pendingRedirect: false,
    redirectHandled: state.redirectHandled,
  });
  logAuthDiagnostic({
    stage: "session-mint",
    method: "session",
    detail: { result: "established-by-screen", onboarding_complete: input.onboardingComplete },
  });
}

/** Test hook: forget memoised state between cases. */
export function resetAuthLifecycleForTests(): void {
  run = null;
  mintInFlight = null;
  listenerAttached = false;
  state = { ...INITIAL_STATE };
  listeners.clear();
}
