// =============================================================================
// Google/Facebook sign-in transport + failure reporting.
//
// These tests pin the behaviour that the domain migration broke:
//   • the active flow is a full-page redirect (no popup anywhere);
//   • a redirect result is consumed exactly once per page load;
//   • a session-cookie failure is reported as a SESSION problem, never as
//     "we couldn't finish Google sign-in" (that conflation hid a 403 from the
//     origin allowlist behind a generic Google message);
//   • cancelling and account-exists cases stay understandable;
//   • linking uses the redirect too and cannot silently sign someone else in.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  signInWithRedirect: vi.fn(),
  linkWithRedirect: vi.fn(),
  getRedirectResult: vi.fn(),
  getAdditionalUserInfo: vi.fn(),
  signOut: vi.fn(),
  mintSessionCookie: vi.fn(),
  state: { currentUser: null as null | { uid: string; providerData: { providerId: string }[] } },
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {
    setCustomParameters() {}
    addScope() {}
  },
  FacebookAuthProvider: class {
    addScope() {}
  },
  signInWithRedirect: mocks.signInWithRedirect,
  linkWithRedirect: mocks.linkWithRedirect,
  getRedirectResult: mocks.getRedirectResult,
  getAdditionalUserInfo: mocks.getAdditionalUserInfo,
  signOut: mocks.signOut,
}));

vi.mock("@/lib/firebase/client", () => ({
  fbAuth: () => ({ get currentUser() { return mocks.state.currentUser; } }),
}));

vi.mock("@/lib/client/api", () => ({
  mintSessionCookie: mocks.mintSessionCookie,
}));

// Deterministic, inspectable storage instead of the browser's.
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
    __dump: () => Object.fromEntries(map),
  };
}

const GOOGLE_CRED = {
  user: { uid: "uid-1", providerData: [{ providerId: "google.com" }] },
  providerId: "google.com",
  operationType: "signIn" as const,
};

function installWindow(storage: ReturnType<typeof memoryStorage>) {
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: storage,
    location: { hostname: "qorvyna.thamjj13.top", origin: "https://qorvyna.thamjj13.top" },
    isSecureContext: true,
  };
}

async function loadOAuth() {
  vi.resetModules();
  return import("@/lib/auth/oauth");
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  installWindow(memoryStorage());
  mocks.state.currentUser = { uid: "uid-1", providerData: [{ providerId: "password" }] };
  mocks.signInWithRedirect.mockResolvedValue(undefined);
  mocks.linkWithRedirect.mockResolvedValue(undefined);
  mocks.getRedirectResult.mockResolvedValue(null);
  mocks.getAdditionalUserInfo.mockReturnValue({ isNewUser: false });
  mocks.mintSessionCookie.mockResolvedValue({ ok: true, uid: "uid-1", onboarding_complete: false });
  // Diagnostics are intentionally chatty; keep the test output readable.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("redirect transport", () => {
  it("starts a full-page redirect and remembers the intended destination", async () => {
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google", { next: "/projects/42" });
    expect(result).toEqual({ status: "redirecting" });
    expect(mocks.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithRedirect.mock.calls[0][0]).toBeTruthy();
    expect(oauth.oauthRedirectPending()).toBe(true);
    expect(oauth.rememberedPostLoginPath()).toBe("/projects/42");
  });

  it("never uses the popup transport in the active flow", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/lib/auth/oauth.ts"), "utf8");
    expect(source).not.toContain("signInWithPopup");
    expect(source).not.toContain("linkWithPopup");
    expect(source).not.toContain("signInWithOAuth");
    for (const file of ["src/components/auth/login-screen.tsx", "src/app/(auth)/register/register-form.tsx"]) {
      const text = readFileSync(path.resolve(__dirname, "..", file), "utf8");
      expect(text, file).not.toContain("signInWithPopup");
    }
  });

  it("surfaces a synchronous redirect refusal as an actionable error", async () => {
    mocks.signInWithRedirect.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "auth/operation-not-supported-in-this-environment" }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toMatch(/in-app browser/i);
    // A refused redirect must not leave a "pending" marker that blocks retries.
    expect(oauth.oauthRedirectPending()).toBe(false);
  });

  it("works without sessionStorage (private mode / storage blocked)", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      location: { hostname: "qorvyna.thamjj13.top", origin: "https://qorvyna.thamjj13.top" },
      isSecureContext: true,
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    };
    const oauth = await loadOAuth();
    await expect(oauth.startOAuthSignIn("google", { next: "/chat" })).resolves.toEqual({ status: "redirecting" });
    expect(oauth.oauthRedirectPending()).toBe(false);
    expect(oauth.rememberedPostLoginPath()).toBeNull();
  });
});

describe("consuming the redirect result", () => {
  it("returns null when there is nothing to consume", async () => {
    const oauth = await loadOAuth();
    await expect(oauth.consumeOAuthRedirect()).resolves.toBeNull();
    expect(mocks.mintSessionCookie).not.toHaveBeenCalled();
  });

  it("mints the app session exactly once, even with concurrent callers", async () => {
    mocks.getRedirectResult.mockResolvedValue(GOOGLE_CRED);
    const oauth = await loadOAuth();
    const [first, second] = await Promise.all([oauth.consumeOAuthRedirect(), oauth.consumeOAuthRedirect()]);
    expect(first).toMatchObject({ status: "ok", uid: "uid-1", operation: "signIn", isNewUser: false });
    expect(second).toBe(first);
    expect(mocks.mintSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("reports a new Google account as isNewUser without creating anything twice", async () => {
    mocks.getRedirectResult.mockResolvedValue(GOOGLE_CRED);
    mocks.getAdditionalUserInfo.mockReturnValue({ isNewUser: true });
    const oauth = await loadOAuth();
    const result = await oauth.consumeOAuthRedirect();
    expect(result).toMatchObject({ status: "ok", isNewUser: true, operation: "signIn" });
    expect(mocks.mintSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("clears the pending marker after a completed sign-in", async () => {
    mocks.getRedirectResult.mockResolvedValue(GOOGLE_CRED);
    const oauth = await loadOAuth();
    await oauth.startOAuthSignIn("google");
    expect(oauth.oauthRedirectPending()).toBe(true);
    await oauth.consumeOAuthRedirect();
    expect(oauth.oauthRedirectPending()).toBe(false);
  });

  it("treats a cancelled redirect as cancelled, not as an error", async () => {
    mocks.getRedirectResult.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "auth/user-cancelled" }));
    const oauth = await loadOAuth();
    await expect(oauth.consumeOAuthRedirect()).resolves.toEqual({ status: "cancelled" });
  });

  it("treats a missing auth event as 'nothing to do'", async () => {
    mocks.getRedirectResult.mockRejectedValue(Object.assign(new Error("none"), { code: "auth/no-auth-event" }));
    const oauth = await loadOAuth();
    await expect(oauth.consumeOAuthRedirect()).resolves.toBeNull();
  });

  it("explains the account-exists-with-different-credential case", async () => {
    mocks.getRedirectResult.mockRejectedValue(
      Object.assign(new Error("exists"), { code: "auth/account-exists-with-different-credential" }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.consumeOAuthRedirect();
    expect(result?.status).toBe("error");
    expect(result?.status === "error" && result.message).toMatch(/email and password/i);
  });

  it("explains a blocked-storage browser instead of a generic failure", async () => {
    mocks.getRedirectResult.mockRejectedValue(
      Object.assign(new Error("storage"), { code: "auth/web-storage-unsupported" }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.consumeOAuthRedirect();
    expect(result?.status === "error" && result.message).toMatch(/cookies|site data/i);
  });
});

describe("session failures are never reported as Google failures", () => {
  it("labels a rejected Origin (403 BAD_ORIGIN) as a deployment/domain problem", async () => {
    mocks.getRedirectResult.mockResolvedValue(GOOGLE_CRED);
    mocks.mintSessionCookie.mockRejectedValue(
      Object.assign(new Error("BAD_ORIGIN: Origin https://qorvyna.thamjj13.top is not allowed"), {
        code: "BAD_ORIGIN",
        status: 403,
      }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.consumeOAuthRedirect();
    expect(result?.status).toBe("session-failed");
    const message = result?.status === "session-failed" ? result.message : "";
    expect(message).toMatch(/domain/i);
    expect(message).toMatch(/NEXT_PUBLIC_APP_URL|QORVYNA_ALLOWED_ORIGINS/);
    expect(message).not.toMatch(/couldn't finish google/i);
  });

  it("keeps the retry-session copy for a 500 from the session endpoint", async () => {
    mocks.getRedirectResult.mockResolvedValue(GOOGLE_CRED);
    mocks.mintSessionCookie.mockRejectedValue(
      Object.assign(new Error("SESSION_MINT_FAILED"), { code: "SESSION_MINT_FAILED", status: 500 }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.consumeOAuthRedirect();
    expect(result?.status).toBe("session-failed");
    expect(result?.status === "session-failed" && result.message).toMatch(/Retry session/);
  });
});

describe("account linking over redirect", () => {
  it("starts a link redirect and remembers what it was doing", async () => {
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthLink("google");
    expect(result).toEqual({ status: "redirecting" });
    expect(mocks.linkWithRedirect).toHaveBeenCalledTimes(1);
    expect(oauth.pendingLinkProvider()).toBe("google");
  });

  it("completes a link without asking the UI to navigate", async () => {
    mocks.getRedirectResult.mockResolvedValue({ ...GOOGLE_CRED, operationType: "link" });
    const oauth = await loadOAuth();
    const start = await oauth.startOAuthLink("google");
    expect(start.status).toBe("redirecting");
    const result = await oauth.consumeOAuthRedirect();
    expect(result).toMatchObject({ status: "ok", operation: "link" });
    expect(oauth.pendingLinkProvider()).toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("refuses to treat a fresh sign-in as a successful link", async () => {
    mocks.getRedirectResult.mockResolvedValue({ ...GOOGLE_CRED, operationType: "signIn" });
    const oauth = await loadOAuth();
    await oauth.startOAuthLink("google");
    const result = await oauth.consumeOAuthRedirect();
    expect(result?.status).toBe("error");
    expect(result?.status === "error" && result.message).toMatch(/couldn't link/i);
    expect(mocks.signOut).toHaveBeenCalled();
    expect(oauth.pendingLinkProvider()).toBeNull();
  });

  it("reports a link that never came back instead of hanging", async () => {
    mocks.getRedirectResult.mockResolvedValue(null);
    const oauth = await loadOAuth();
    await oauth.startOAuthLink("google");
    const result = await oauth.consumeOAuthRedirect();
    expect(result?.status).toBe("error");
    expect(result?.status === "error" && result.message).toMatch(/didn't complete/i);
    expect(oauth.pendingLinkProvider()).toBeNull();
  });

  it("requires a signed-in user before linking", async () => {
    mocks.state.currentUser = null;
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthLink("google");
    expect(result.status).toBe("error");
    expect(mocks.linkWithRedirect).not.toHaveBeenCalled();
  });

  it("passes cred.user to mintSessionCookie so session mint works even if auth.currentUser lags", async () => {
    mocks.state.currentUser = null;
    mocks.getRedirectResult.mockResolvedValue(GOOGLE_CRED);
    const oauth = await loadOAuth();
    const result = await oauth.consumeOAuthRedirect();
    expect(result).toMatchObject({ status: "ok", uid: "uid-1", operation: "signIn" });
    expect(mocks.mintSessionCookie).toHaveBeenCalledWith(GOOGLE_CRED.user, undefined);
  });

  it("emits REDIRECT_RESULT_STARTED, REDIRECT_RESULT_COMPLETED, AUTH_USER_DETECTED and AUTH_REDIRECT_ERROR safely", async () => {
    mocks.getRedirectResult.mockResolvedValue(GOOGLE_CRED);
    const oauth = await loadOAuth();
    await oauth.consumeOAuthRedirect();
    const loggedText = warn.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(loggedText).toContain("REDIRECT_RESULT_STARTED");
    expect(loggedText).toContain("REDIRECT_RESULT_COMPLETED");
    expect(loggedText).toContain("AUTH_USER_DETECTED");

    warn.mockClear();
    mocks.getRedirectResult.mockRejectedValue(Object.assign(new Error("boom"), { code: "auth/unauthorized-domain" }));
    const oauthErr = await loadOAuth();
    await oauthErr.consumeOAuthRedirect();
    const errText = warn.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(errText).toContain("AUTH_REDIRECT_ERROR");
  });
});

describe("post-login destination", () => {
  it("prefers the URL's next parameter and rejects off-site targets", async () => {
    const oauth = await loadOAuth();
    expect(oauth.postAuthPath(false, "/devices")).toBe("/devices");
    expect(oauth.postAuthPath(false, "//evil.example")).toBe("/chat");
    expect(oauth.postAuthPath(false, "/login")).toBe("/chat");
    expect(oauth.postAuthPath(false, null)).toBe("/chat");
  });

  it("falls back to the remembered path after a reload", async () => {
    const oauth = await loadOAuth();
    oauth.rememberPostLoginPath("/workspace");
    expect(oauth.postAuthPath(false, null)).toBe("/workspace");
  });

  it("ignores a stale remembered path", async () => {
    const storage = memoryStorage();
    installWindow(storage);
    storage.setItem("qorvyna.oauth.next", JSON.stringify({ path: "/devices", at: Date.now() - 60 * 60 * 1000 }));
    const oauth = await loadOAuth();
    expect(oauth.rememberedPostLoginPath()).toBeNull();
    expect(oauth.postAuthPath(false, null)).toBe("/chat");
  });
});
