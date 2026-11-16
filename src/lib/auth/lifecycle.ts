"use client";

// =============================================================================
// Centralised authentication lifecycle (client).
//
// Owns initial Firebase Auth state restoration, shared `onAuthStateChanged`
// mirroring, backend `__session` verification/minting, and profile readiness
// once per page load:
//
//   INITIALIZING ──► initial auth state + browserLocalPersistence
//        │                                 │
//        │            UNAUTHENTICATED ◄────┤ (no Firebase user)
//        │            ERROR ◄──────────────┤ (stage failed)
//        ▼                                 ▼
//   PROFILE_LOADING ◄── session established (cookie verified or minted)
//        │
//        ▼
//       READY  (only now may a guard navigate or chat initialize)
//
// Rules encoded here:
//   • Uses a single shared Firebase Auth instance (`fbAuth()`).
//   • The initial `onAuthStateChanged` / `authStateReady` is awaited;
//     "still restoring" is never mistaken for "logged out".
//   • Firebase Auth persistence is pinned to `browserLocalPersistence`.
//   • Every stage is timed out and reported as a RECOVERABLE ERROR state —
//     never an infinite spinner, and never forcing authenticated state without
//     both Firebase identity and a verified backend session + profile.
//   • Diagnostics name each stage without ever carrying tokens or credentials.
// =============================================================================

import { browserLocalPersistence, onAuthStateChanged, setPersistence } from "firebase/auth";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";
import type { SessionProfileSummary } from "@/lib/client/api";
import { completeAuthenticatedSession } from "@/lib/auth/oauth";
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
  profile: SessionProfileSummary | null;
  profileLoaded: boolean;
  onboardingComplete: boolean;
  error: AuthLifecycleError | null;
};

const INITIAL_STATE_TIMEOUT_MS = 5_000;
const SESSION_TIMEOUT_MS = 15_000;

const INITIAL_STATE: AuthLifecycleState = {
  status: "INITIALIZING",
  user: null,
  profile: null,
  profileLoaded: false,
  onboardingComplete: false,
  error: null,
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

/** Wait for Firebase's initial auth state (authStateReady + onAuthStateChanged). */
async function waitInitialAuthState(timeoutMs: number): Promise<{ user: AuthLifecycleUser | null; timedOut: boolean }> {
  const auth = fbAuth();
  if (auth.currentUser) {
    const user = auth.currentUser;
    logAuthDiagnostic({
      event: "AUTH_USER_DETECTED",
      stage: "auth-state",
      method: "session",
      detail: { source: "currentUser", uidPresent: Boolean(user.uid) },
    });
    return { user: { uid: user.uid, email: user.email ?? null }, timedOut: false };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { user: AuthLifecycleUser | null; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      logAuthDiagnostic({
        event: "AUTH_STATE_CHANGED",
        stage: "auth-state",
        method: "session",
        detail: { user_present: Boolean(result.user), timed_out: result.timedOut },
      });
      if (result.user) {
        logAuthDiagnostic({
          event: "AUTH_USER_DETECTED",
          stage: "auth-state",
          method: "session",
          detail: { source: "initial_auth_state", uidPresent: true },
        });
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ user: null, timedOut: true }), timeoutMs);
    const unsub = onAuthStateChanged(auth, (user) => {
      finish({ user: user ? { uid: user.uid, email: user.email ?? null } : null, timedOut: false });
    });
    if (typeof (auth as { authStateReady?: () => Promise<void> }).authStateReady === "function") {
      void (auth as { authStateReady: () => Promise<void> })
        .authStateReady()
        .then(() => {
          const current = auth.currentUser;
          finish({ user: current ? { uid: current.uid, email: current.email ?? null } : null, timedOut: false });
        })
        .catch(() => {
          /* rely on onAuthStateChanged or timeout */
        });
    }
  });
}

type SessionStatus = {
  authenticated?: boolean;
  uid?: string;
  onboarding_complete?: boolean;
  profile_loaded?: boolean;
  profile_error?: string;
  profile?: SessionProfileSummary | null;
};

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
let mintInFlight: Promise<{
  uid: string;
  onboardingComplete: boolean;
  profileLoaded: boolean;
  profile: SessionProfileSummary | null;
}> | null = null;

async function ensureBackendSession(): Promise<{
  uid: string;
  onboardingComplete: boolean;
  profileLoaded: boolean;
  profile: SessionProfileSummary | null;
}> {
  if (mintInFlight) return mintInFlight;
  mintInFlight = (async () => {
    logAuthDiagnostic({
      event: "BACKEND_AUTH_CHECK",
      stage: "session-check",
      method: "session",
      detail: { step: "cookie-probe-start" },
    });
    const status = await withTimeout(
      fetchSessionStatus(),
      SESSION_TIMEOUT_MS,
      () => new Error("The server did not answer the session check in time."),
    );
    if (status?.authenticated && status.profile_loaded !== false) {
      logAuthDiagnostic({
        event: "BACKEND_AUTH_CHECK",
        stage: "session-check",
        method: "session",
        detail: {
          result: "cookie-valid",
          uid_present: Boolean(status.uid),
          profile_loaded: true,
        },
      });
      return {
        uid: status.uid ?? "",
        onboardingComplete: status.onboarding_complete === true,
        profileLoaded: true,
        profile: status.profile ?? null,
      };
    }
    logAuthDiagnostic({
      event: "BACKEND_AUTH_CHECK",
      stage: "id-token",
      method: "session",
      detail: { step: "retrieve-and-validate", reason: status?.authenticated ? "profile-reload" : "cookie-missing" },
    });
    const session = await withTimeout(
      completeAuthenticatedSession(),
      SESSION_TIMEOUT_MS,
      () => new Error("The server did not create your session in time."),
    );
    if (session.profileLoaded === false) {
      throw new Error("Signed in with your account, but your profile could not be loaded.");
    }
    logAuthDiagnostic({
      event: "BACKEND_AUTH_CHECK",
      stage: "session-mint",
      method: "session",
      detail: {
        result: "minted",
        onboarding_complete: session.onboardingComplete,
        profile_loaded: true,
      },
    });
    return {
      uid: session.uid,
      onboardingComplete: session.onboardingComplete,
      profileLoaded: true,
      profile: session.profile ?? null,
    };
  })().finally(() => {
    mintInFlight = null;
  });
  return mintInFlight;
}

// -----------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------

async function runLifecycle(): Promise<AuthLifecycleState> {
  setState({ status: "INITIALIZING", error: null });

  if (!firebaseBrowserConfigured) {
    return fail(
      "auth-init",
      "QORVYNA is not connected to its backend services yet, so authentication is unavailable. The administrator must set the NEXT_PUBLIC_FIREBASE_* variables and redeploy.",
    );
  }

  const auth = fbAuth();

  // 1. Wait for Firebase's initial authentication state (authStateReady +
  //    onAuthStateChanged). Never decide "logged out" while the SDK is restoring.
  const initial = await waitInitialAuthState(INITIAL_STATE_TIMEOUT_MS).catch((error: unknown) => {
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

  // 2. Confirm browserLocalPersistence is active. Because initializeAuth()
  //    already sets browserLocalPersistence first in the browser and initial
  //    auth state already resolved above, this never stalls behind
  //    _initializationPromise. Failure here is logged but never fatal.
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

  const currentUser = fbAuth().currentUser;
  const effectiveUser: AuthLifecycleUser | null =
    initial.user ?? (currentUser ? { uid: currentUser.uid, email: currentUser.email ?? null } : null);

  // 3. Backend session + profile loading. With a Firebase user we verify the
  //    cookie independently first and mint only when missing/invalid.
  if (effectiveUser) {
    logAuthDiagnostic({
      event: "PROFILE_LOADING",
      stage: "profile",
      method: "session",
      detail: { step: "start", uid_present: true },
    });
    setState({ status: "PROFILE_LOADING", user: effectiveUser });
    try {
      const session = await ensureBackendSession();
      logAuthDiagnostic({
        event: "PROFILE_LOADING",
        stage: "profile",
        method: "session",
        detail: {
          ensured_by: session.uid ? "session-mint-or-cookie" : "unknown",
          onboarding_complete: session.onboardingComplete,
          profile_loaded: session.profileLoaded,
        },
      });
      setState({
        status: "READY",
        user: { uid: session.uid || effectiveUser.uid, email: effectiveUser.email },
        profile: session.profile,
        profileLoaded: session.profileLoaded,
        onboardingComplete: session.onboardingComplete,
        error: null,
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

  // 4. No Firebase user after initial state restoration: genuine signed-out visitor.
  logAuthDiagnostic({ stage: "auth-state", method: "session", detail: { decision: "unauthenticated" } });
  setState({
    status: "UNAUTHENTICATED",
    user: null,
    profile: null,
    profileLoaded: false,
    onboardingComplete: false,
    error: null,
  });
  return state;
}

function attachStateMirror(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  // Mirror Firebase's shared `onAuthStateChanged` listener so identity changes
  // (popup login, cross-tab restore, sign-out) are always reflected cleanly
  // without manually forcing authenticated state before a verified session.
  try {
    onAuthStateChanged(fbAuth(), (user) => {
      logAuthDiagnostic({
        event: "AUTH_STATE_CHANGED",
        stage: "auth-state",
        method: "session",
        detail: { user_present: Boolean(user), current_status: state.status },
      });
      if (!user) {
        if (state.status === "READY" || state.status === "AUTHENTICATED" || state.status === "PROFILE_LOADING") {
          logAuthDiagnostic({ stage: "auth-state", method: "session", detail: { decision: "signed-out" } });
          setState({
            status: "UNAUTHENTICATED",
            user: null,
            profile: null,
            profileLoaded: false,
            onboardingComplete: false,
          });
        }
        return;
      }

      logAuthDiagnostic({
        event: "AUTH_USER_DETECTED",
        stage: "auth-state",
        method: "session",
        detail: { source: "state_mirror", uidPresent: Boolean(user.uid) },
      });
      const nextUser: AuthLifecycleUser = { uid: user.uid, email: user.email ?? null };
      if (state.user?.uid !== user.uid) {
        setState({ user: nextUser });
      }
      // If initial auth-state timed out transiently before Firebase finished
      // restoring the user, promote through backend session verification.
      if (state.status === "ERROR" && state.error?.stage === "auth-state") {
        setState({ status: "PROFILE_LOADING", user: nextUser, error: null });
        void ensureBackendSession()
          .then((session) => {
            setState({
              status: "READY",
              user: { uid: session.uid || nextUser.uid, email: nextUser.email },
              profile: session.profile,
              profileLoaded: session.profileLoaded,
              onboardingComplete: session.onboardingComplete,
              error: null,
            });
          })
          .catch((error: unknown) => {
            fail(
              "session-mint",
              "Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.",
              error,
            );
          });
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

/** Reset client lifecycle + loop guard on explicit sign-out. */
export function resetAuthLifecycleOnSignOut(): void {
  resetPostLoginNavigationGuard();
  run = null;
  mintInFlight = null;
  setState({
    status: "UNAUTHENTICATED",
    user: null,
    profile: null,
    profileLoaded: false,
    onboardingComplete: false,
    error: null,
  });
}

// -----------------------------------------------------------------------------
// Redirect-loop protection
// -----------------------------------------------------------------------------

const K_NAV_ATTEMPTS = "qorvyna.auth.nav-attempts";
const NAV_WINDOW_MS = 120_000;
const MAX_NAV_ATTEMPTS = 2;

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
    return true;
  }
}

export function resetPostLoginNavigationGuard(): void {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    window.sessionStorage.removeItem(K_NAV_ATTEMPTS);
  } catch {
    /* ignore */
  }
}

/**
 * Called by a screen only AFTER both Firebase authentication AND the backend
 * session/profile call succeeded, so the shared state reflects reality before
 * navigating. Never forces READY if uid is missing or profile failed to load.
 */
export function markSessionEstablished(input: {
  uid: string;
  onboardingComplete: boolean;
  profileLoaded?: boolean;
  profile?: SessionProfileSummary | null;
}): void {
  if (!input.uid || input.profileLoaded === false) {
    fail("profile", "Signed in with your account, but your profile could not be loaded. Tap Retry.");
    return;
  }
  setState({
    status: "READY",
    user: { uid: input.uid, email: state.user?.email ?? fbAuth().currentUser?.email ?? null },
    profile: input.profile !== undefined ? input.profile : state.profile,
    profileLoaded: true,
    onboardingComplete: input.onboardingComplete,
    error: null,
  });
  logAuthDiagnostic({
    event: "BACKEND_AUTH_CHECK",
    stage: "session-mint",
    method: "session",
    detail: {
      result: "established-by-screen",
      onboarding_complete: input.onboardingComplete,
      profile_loaded: true,
    },
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
