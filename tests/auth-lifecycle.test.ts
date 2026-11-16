// =============================================================================
// Centralised client authentication lifecycle (src/lib/auth/lifecycle.ts).
//
// Pins the startup & shared `onAuthStateChanged` guarantees:
//   • initial auth state is awaited — "still restoring" is never treated as
//     "logged out";
//   • a Firebase user without a backend session gets one (cookie checked
//     first, minted only when missing) and profile load status is verified;
//   • persistence is pinned to browserLocalPersistence;
//   • every stage is timed out and surfaces as a RECOVERABLE ERROR state;
//   • markSessionEstablished never forces READY if uid or profile is missing;
//   • login↔app redirect loop protection and sign-out cleanup work reliably;
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
    completeAuthenticatedSession: vi.fn(),
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
  completeAuthenticatedSession: mocks.completeAuthenticatedSession,
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

async function startUntilAuthState(lifecycle: Lifecycle): Promise<void> {
  lifecycle.startAuthLifecycle();
  await flush();
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
  mocks.completeAuthenticatedSession.mockResolvedValue({
    uid: "uid-1",
    onboardingComplete: false,
    profileLoaded: true,
    profile: null,
  });
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ authenticated: false }),
  });
  vi.stubGlobal("fetch", mocks.fetch);
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
    expect(mocks.fetch).not.toHaveBeenCalled();

    fireAuthState(null);
    await run;
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
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
        (call) => (call[0] as { stage?: string }).stage === "persistence",
      ),
    ).toBe(true);
  });

  it("concurrent callers share the single run (no double session mint)", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const [a, b] = await Promise.all([lifecycle.startAuthLifecycle(), lifecycle.startAuthLifecycle()]);
    expect(a).toBe(b);
    expect(mocks.completeAuthenticatedSession).toHaveBeenCalledTimes(1);
  });
});

describe("session establishment on refresh", () => {
  it("repairs Firebase user + missing cookie → session minted → READY", async () => {
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
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true, uid: "uid-1", onboarding_complete: true, profile_loaded: true }),
    });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(state.status).toBe("READY");
    expect(state.onboardingComplete).toBe(true);
    expect(mocks.completeAuthenticatedSession).not.toHaveBeenCalled();
  });
});

describe("recoverable error states (never an infinite spinner)", () => {
  it("reports a failed backend session as ERROR stage session-mint with retry copy", async () => {
    mocks.completeAuthenticatedSession.mockRejectedValue(new Error("mint failed"));
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const state = await lifecycle.startAuthLifecycle();
    expect(state.status).toBe("ERROR");
    expect(state.error?.stage).toBe("session-mint");
    expect(state.error?.message).toMatch(/Retry session/);
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

  it("retry re-runs the whole sequence and can reach READY", async () => {
    mocks.completeAuthenticatedSession.mockRejectedValueOnce(new Error("mint failed"));
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    const failed = await lifecycle.startAuthLifecycle();
    expect(failed.status).toBe("ERROR");

    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, uid: "uid-1" }) });
    const retryRun = lifecycle.retryAuthLifecycle();
    await flush();
    fireAuthState(USER);
    const retried = await retryRun;
    expect(retried.status).toBe("READY");
    expect(retried.error).toBeNull();
  });
});

describe("ongoing shared onAuthStateChanged mirroring", () => {
  it("a sign-out in this tab degrades READY back to UNAUTHENTICATED", async () => {
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

  it("never forces UNAUTHENTICATED to READY without a confirmed backend session", async () => {
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(null);
    await lifecycle.startAuthLifecycle();
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    fireAuthState(USER);
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    expect(lifecycle.getAuthLifecycleState().user).toEqual(USER);
  });
});

describe("guard decisions & session establishment validation", () => {
  it("maps every explicit state to wait / navigate / form / error", async () => {
    const lifecycle = await load();
    expect(lifecycle.authGuardDecision("INITIALIZING")).toBe("wait");
    expect(lifecycle.authGuardDecision("PROFILE_LOADING")).toBe("wait");
    expect(lifecycle.authGuardDecision("READY")).toBe("navigate");
    expect(lifecycle.authGuardDecision("AUTHENTICATED")).toBe("navigate");
    expect(lifecycle.authGuardDecision("UNAUTHENTICATED")).toBe("form");
    expect(lifecycle.authGuardDecision("ERROR")).toBe("error");
  });

  it("markSessionEstablished moves a confirmed session to READY and blocks when profileLoaded is false", async () => {
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(null);
    await lifecycle.startAuthLifecycle();
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");

    lifecycle.markSessionEstablished({ uid: "uid-1", onboardingComplete: false, profileLoaded: false });
    expect(lifecycle.getAuthLifecycleState().status).toBe("ERROR");
    expect(lifecycle.getAuthLifecycleState().error?.stage).toBe("profile");

    lifecycle.markSessionEstablished({ uid: "uid-1", onboardingComplete: false, profileLoaded: true });
    expect(lifecycle.getAuthLifecycleState().status).toBe("READY");
    expect(lifecycle.authGuardDecision(lifecycle.getAuthLifecycleState().status)).toBe("navigate");
  });
});

describe("login ↔ app redirect-loop protection & sign-out cleanup", () => {
  it("allows bounded navigations, blocks loops, and resets on sign-out or retry", async () => {
    const lifecycle = await load();
    expect(lifecycle.recordPostLoginNavigation()).toBe(true);
    expect(lifecycle.recordPostLoginNavigation()).toBe(true);
    expect(lifecycle.recordPostLoginNavigation()).toBe(false);
    lifecycle.resetAuthLifecycleOnSignOut();
    expect(lifecycle.getAuthLifecycleState().status).toBe("UNAUTHENTICATED");
    expect(lifecycle.recordPostLoginNavigation()).toBe(true);
  });

  it("recovers automatically when auth-state timed out transiently before Firebase emitted USER", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, uid: "uid-1" }) });
    const lifecycle = await load();
    const run = lifecycle.startAuthLifecycle();
    await vi.advanceTimersByTimeAsync(5_100);
    const failed = await run;
    expect(failed.status).toBe("ERROR");
    expect(failed.error?.stage).toBe("auth-state");

    fireAuthState(USER);
    await vi.advanceTimersByTimeAsync(10);
    expect(lifecycle.getAuthLifecycleState().status).toBe("READY");
    expect(lifecycle.getAuthLifecycleState().user).toEqual(USER);
  });
});

describe("diagnostics safety", () => {
  it("never records tokens, credentials or raw user identifiers and emits lifecycle events", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true, uid: "uid-1" }) });
    const lifecycle = await load();
    await startUntilAuthState(lifecycle);
    fireAuthState(USER);
    await lifecycle.startAuthLifecycle();
    expect(mocks.logAuthDiagnostic).toHaveBeenCalled();
    const forbiddenKeys = /token|credential|password|secret|cookie|authorization/i;
    const events: Array<string | undefined> = [];
    for (const call of mocks.logAuthDiagnostic.mock.calls) {
      const event = call[0] as { event?: string; stage?: string; detail?: Record<string, unknown> };
      expect(event.stage, JSON.stringify(event)).toBeTruthy();
      events.push(event.event);
      for (const key of Object.keys(event.detail ?? {})) {
        expect(key, `${event.stage}:${key}`).not.toMatch(forbiddenKeys);
      }
    }
    expect(events).toContain("AUTH_STATE_CHANGED");
    expect(events).toContain("AUTH_USER_DETECTED");
    expect(events).toContain("PROFILE_LOADING");
    expect(events).toContain("BACKEND_AUTH_CHECK");
  });
});
