// =============================================================================
// Centralised post-redirect auth lifecycle (src/lib/auth/lifecycle.ts).
//
// These tests pin the behaviour that fixes "Google returns to /login but the
// chat never loads":
//   • getRedirectResult() is processed at application startup, exactly once,
//     BEFORE any screen can decide the visitor is logged out;
//   • the initial onAuthStateChanged is awaited — "still restoring" is never
//     treated as "logged out";
//   • a Firebase user without a backend session gets one (cookie checked
//     first, minted only when missing) instead of leaving the visitor on the
//     login form;
//   • every stage is timed out and surfaces as a RECOVERABLE ERROR state —
//     never an infinite spinner;
//   • persistence is pinned to browserLocalPersistence and auth state is
//     never cleared during redirect processing;
//   • the login↔app bounce is detected and stopped;
//   • diagnostics never carry tokens.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const authCallbacks: Array<(user: { uid: string; email: string | null } | null) => void> = [];
  return {
    authCallbacks,
    configured: true,
    currentUser: null as { uid: string; email: string | null } | null,
    setPersistence: vi.fn(async (_auth: unknown, _persistence: unknown) => {}),
    onAuthStateChanged: vi.fn((auth: unknown, cb: (user: unknown) => void) => {
      authCallbacks.push(cb as (user: { uid: string; email: string | null } | null) => void);
      return () => {
        const index = authCallbacks.indexOf(cb as never);
        if (index >= 0) authCallbacks.splice(index, 1);
      };
    }),
    browserLocalPersistence: { type: "LOCAL" as const },
    consumeOAuthRedirect: vi.fn(),
    completeAuthenticatedSession: vi.fn(),
    oauthRedirectPending: vi.fn(() => false),
    logAuthDiagnostic: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: mocks.browserLocalPersistence,
  onAuthStateChanged: mocks.onAuthStateChanged,
  setPersistence: mocks.setPersistence,
}));

vi.mock("@/lib/firebase/client", () => ({
  fbAuth: () => ({ get currentUser() { return mocks.currentUser; } }),
  get firebaseBrowserConfigured() {
    return mocks.configured;
  },
}));

vi.mock("@/lib/auth/oauth", () => ({
  consumeOAuthRedirect: mocks.consumeOAuthRedirect,
  completeAuthenticatedSession: mocks.completeAuthenticatedSession,
  oauthRedirectPending: mocks.oauthRedirectPending,
}));

vi.mock("@/lib/auth/diagnostics", () => ({
  logAuthDiagnostic: mocks.logAuthDiagnostic,
}));

type Lifecycle = typeof import("@/lib/auth/lifecycle");

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function installWindow() {
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: memoryStorage(),
    location: { hostname: "qorvyna.thamjj13.top", origin: "https://qorvyna.thamjj13.top" },
    isSecureContext: true,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load(): Promise<Lifecycle> {
  return import("@/lib/auth/lifecycle");
}

/** Run the lifecycle up to (and including) the initial auth-state wait. */
async function startUntilAuthState(lifecycle: Lifecycle): Promise<void> {
  lifecycle.startAuthLifecycle();
  await flush(); // persistence + initial-state subscription are registered
}

function fireAuthState(user: { uid: string; email: string | null } | null): void {
  for (const callback of [...mocks.authCallbacks]) callback(user);
}

const USER = { uid: "uid-1", email: "one@example.com" };

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.authCallbacks.length = 0;
  installWindow();
  mocks.configured = true;
  mocks.currentUser = null;
  mocks.oauthRedirectPending.mockReturnValue(false);
  mocks.consumeOAuthRedirect.mockResolvedValue(null);
  mocks.completeAuthenticatedSession.mockResolvedValue({ uid: "uid-1", onboardingComplete: false });
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ authenticated: false }),
  });
  vi.stubGlobal("fetch", mocks.fetch);
  // The lifecycle module is stateful (memoised run, listeners): reset it.
  (await load()).resetAuthLifecycleForTests();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("initialisation ordering", () => {
  it("stays INITIALIZING until Firebase's first auth state arrives — never 'logged out' early", async () => {
    const lifecycle = await load();
    const run = lifecycle.startAuthLifecycle();
    await flush();
    expect(lifecycle.getAuthLifecycleState().status).toBe("INITIALIZING");
    // Nothing downstream may run before the initial state is known.
    expect(mocks.consumeOAuthRedirect).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();

    fireAuthState(null);
    await run;
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    expect(mocks.consumeOAuthRedirect).toHaveBeenCalledTimes(1);
    // A signed-out visitor never touches the session endpoint.
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.completeAuthenticatedSession).not.toHaveBeenCalled();
  });

  it("pins Firebase persistence to browserLocalPersistence during startup", async () => {
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(null);
    await flush();
    expect(mocks.setPersistence).toHaveBeenCalledTimes(1);
    expect(mocks.setPersistence.mock.calls[0][1]).toBe(mocks.browserLocalPersistence);
    expect(
      mocks.logAuthDiagnostic.mock.calls.some(
        (call) => (call[0] as { stage?: string; detail?: Record<string, unknown> }).stage === "persistence",
      ),
    ).toBe(true);
  });

  it("processes the redirect result exactly once, before any screen decides anything", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue({
      status: "ok",
      uid: "uid-1",
      onboardingComplete: true,
      provider: "google",
      isNewUser: true,
      operation: "signIn",
    });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(mocks.consumeOAuthRedirect).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("READY");
    expect(state.redirectHandled).toBe(true);
    expect(state.user).toEqual({ uid: "uid-1", email: USER.email });
    expect(state.onboardingComplete).toBe(true);
    // The redirect flow already minted the session: no second mint, no GET.
    expect(mocks.completeAuthenticatedSession).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("concurrent callers share the single run (no double session mint)", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const [a, b] = await Promise.all([lifecycle.startAuthLifecycle(), lifecycle.startAuthLifecycle()]);
    expect(a).toBe(b);
    expect(mocks.consumeOAuthRedirect).toHaveBeenCalledTimes(1);
    expect(mocks.completeAuthenticatedSession).toHaveBeenCalledTimes(1);
  });
});

describe("session establishment after the redirect", () => {
  it("repairs the stuck state: Firebase user + no cookie → session minted → READY", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue(null); // result absent/already consumed
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(state.status).toBe("READY");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.completeAuthenticatedSession).toHaveBeenCalledTimes(1);
    expect(state.user?.uid).toBe("uid-1");
  });

  it("accepts an existing valid cookie without minting again", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true, uid: "uid-1", onboarding_complete: true }),
    });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(state.status).toBe("READY");
    expect(state.onboardingComplete).toBe(true);
    expect(mocks.completeAuthenticatedSession).not.toHaveBeenCalled();
  });

  it("a cancelled redirect falls through to the same session recovery", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue({ status: "cancelled" });
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(state.status).toBe("READY");
    expect(mocks.completeAuthenticatedSession).toHaveBeenCalledTimes(1);
  });
});

describe("recoverable error states (never an infinite spinner)", () => {
  it("reports a failed backend session as ERROR stage session-mint with retry copy", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue({
      status: "session-failed",
      message: "Signed in with your account, but the server could not create your session. Tap Retry session.",
      provider: "google",
    });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(state.status).toBe("ERROR");
    expect(state.error?.stage).toBe("session-mint");
    expect(state.error?.message).toMatch(/Retry session/);
  });

  it("reports a failed redirect result as ERROR stage redirect-result", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue({ status: "error", message: "Server setup problem.", provider: "google" });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(state.status).toBe("ERROR");
    expect(state.error?.stage).toBe("redirect-result");
    expect(state.error?.message).toMatch(/Server setup problem/);
  });

  it("times out a hanging initial auth state instead of waiting for ever", async () => {
    vi.useFakeTimers();
    const lifecycle = await load();
    const run = lifecycle.startAuthLifecycle();
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.getAuthLifecycleState().status).toBe("INITIALIZING");
    await vi.advanceTimersByTimeAsync(5_100);
    const state = await run;
    expect(state.status).toBe("ERROR");
    expect(state.error?.stage).toBe("auth-state");
  });

  it("times out a hanging getRedirectResult instead of an endless 'Finishing sign-in…'", async () => {
    vi.useFakeTimers();
    mocks.consumeOAuthRedirect.mockReturnValue(new Promise(() => {}));
    const lifecycle = await load();
    const run = lifecycle.startAuthLifecycle();
    await vi.advanceTimersByTimeAsync(1);
    fireAuthState(USER);
    await vi.advanceTimersByTimeAsync(15_100);
    const state = await run;
    expect(state.status).toBe("ERROR");
    expect(state.error?.stage).toBe("redirect-result");
    expect(state.error?.message).toMatch(/Retry/);
  });

  it("retry re-runs the whole sequence and can reach READY", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValueOnce({ status: "error", message: "try again", provider: "google" });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const failed = await lifecycle.startAuthLifecycle();
    expect(failed.status).toBe("ERROR");

    // The second attempt succeeds: the session endpoint now confirms a cookie.
    mocks.consumeOAuthRedirect.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, uid: "uid-1" }) });
    const retryRun = lifecycle.retryAuthLifecycle();
    await flush(); // the re-run subscribes to the initial auth state again
    fireAuthState(USER);
    const retried = await retryRun;
    expect(retried.status).toBe("READY");
    expect(retried.error).toBeNull();
  });
});

describe("ongoing auth state", () => {
  it("a sign-out in this tab degrades READY back to UNAUTHENTICATED", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, uid: "uid-1" }) });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    await lifecycle.startAuthLifecycle();
    expect(lifecycle.getAuthLifecycleState().status).toBe("READY");

    fireAuthState(null);
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    expect(lifecycle.getAuthLifecycleState().user).toBeNull();
  });

  it("never upgrades UNAUTHENTICATED to READY without a confirmed session", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue(null);
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(null);
    await lifecycle.startAuthLifecycle();
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    // A user appearing later only fills in identity — status changes only
    // after a confirmed backend session (markSessionEstablished / a re-run).
    fireAuthState(USER);
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    expect(lifecycle.getAuthLifecycleState().user).toEqual(USER);
  });
});

describe("guard decisions (INITIALIZING is never 'logged out')", () => {
  it("maps every explicit state to wait / navigate / form / error", async () => {
    const lifecycle = await load();
    expect(lifecycle.authGuardDecision("INITIALIZING")).toBe("wait");
    expect(lifecycle.authGuardDecision("PROFILE_LOADING")).toBe("wait");
    expect(lifecycle.authGuardDecision("READY")).toBe("navigate");
    expect(lifecycle.authGuardDecision("AUTHENTICATED")).toBe("navigate");
    expect(lifecycle.authGuardDecision("UNAUTHENTICATED")).toBe("form");
    expect(lifecycle.authGuardDecision("ERROR")).toBe("error");
  });

  it("markSessionEstablished moves a password sign-in to READY for the guard", async () => {
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(null);
    await lifecycle.startAuthLifecycle();
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    lifecycle.markSessionEstablished({ uid: "uid-1", onboardingComplete: false });
    expect(lifecycle.getAuthLifecycleState().status).toBe("READY");
    expect(lifecycle.authGuardDecision(lifecycle.getAuthLifecycleState().status)).toBe("navigate");
  });
});

describe("login ↔ app redirect-loop protection", () => {
  it("allows a bounded number of navigations, then blocks, and resets on demand", async () => {
    const lifecycle = await load();
    expect(lifecycle.recordPostLoginNavigation()).toBe(true);
    expect(lifecycle.recordPostLoginNavigation()).toBe(true);
    expect(lifecycle.recordPostLoginNavigation()).toBe(false);
    lifecycle.resetPostLoginNavigationGuard();
    expect(lifecycle.recordPostLoginNavigation()).toBe(true);
  });
});

describe("diagnostics safety", () => {
  it("never records tokens, credentials or raw user identifiers in detail fields", async () => {
    mocks.consumeOAuthRedirect.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, uid: "uid-1" }) });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    await lifecycle.startAuthLifecycle();
    expect(mocks.logAuthDiagnostic).toHaveBeenCalled();
    const forbiddenKeys = /token|credential|password|secret|cookie|authorization/i;
    for (const call of mocks.logAuthDiagnostic.mock.calls) {
      const event = call[0] as { stage?: string; detail?: Record<string, unknown> };
      expect(event.stage, JSON.stringify(event)).toBeTruthy();
      for (const key of Object.keys(event.detail ?? {})) {
        expect(key, `${event.stage}:${key}`).not.toMatch(forbiddenKeys);
      }
    }
  });
});
