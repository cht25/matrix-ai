// =============================================================================
// Google/Facebook popup authentication & failure reporting.
//
// Pins the migration from cross-origin redirect OAuth to popup OAuth:
//   • `signInWithPopup` / `linkWithPopup` are the active transport (no
//     `signInWithRedirect`, `linkWithRedirect`, or `getRedirectResult`);
//   • `credential.user` is verified explicitly before session minting;
//   • Firebase's shared Auth instance (`fbAuth()`) is never duplicated;
//   • all popup/network/domain/credential error codes surface actionable messages;
//   • backend session / profile failures are never mislabelled as Google errors.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  signInWithPopup: vi.fn(),
  linkWithPopup: vi.fn(),
  getAdditionalUserInfo: vi.fn(),
  mintSessionCookie: vi.fn(),
  authStateReady: vi.fn(),
  setCustomParameters: vi.fn(),
  state: { currentUser: null as null | { uid: string; providerData: { providerId: string }[] } },
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {
    setCustomParameters = mocks.setCustomParameters;
    addScope() {}
  },
  FacebookAuthProvider: class {
    addScope() {}
  },
  signInWithPopup: mocks.signInWithPopup,
  linkWithPopup: mocks.linkWithPopup,
  getAdditionalUserInfo: mocks.getAdditionalUserInfo,
}));

vi.mock("@/lib/firebase/client", () => ({
  fbAuth: () => ({
    get currentUser() {
      return mocks.state.currentUser;
    },
    authStateReady: mocks.authStateReady,
  }),
}));

vi.mock("@/lib/client/api", () => ({
  mintSessionCookie: mocks.mintSessionCookie,
}));

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
  mocks.authStateReady.mockResolvedValue(undefined);
  mocks.signInWithPopup.mockImplementation(async () => {
    mocks.state.currentUser = GOOGLE_CRED.user;
    return GOOGLE_CRED;
  });
  mocks.linkWithPopup.mockResolvedValue({ ...GOOGLE_CRED, operationType: "link" });
  mocks.getAdditionalUserInfo.mockReturnValue({ isNewUser: false });
  mocks.mintSessionCookie.mockResolvedValue({
    ok: true,
    uid: "uid-1",
    onboarding_complete: false,
    profile_loaded: true,
    profile: { uid: "uid-1", email: "one@example.com", full_name: "Test User", avatar_url: "" },
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("popup transport & obsolete redirect removal", () => {
  it("removes signInWithRedirect, linkWithRedirect, getRedirectResult and null_redirect_after_pending from the active auth flow", () => {
    for (const file of [
      "src/lib/auth/oauth.ts",
      "src/lib/auth/lifecycle.ts",
      "src/components/auth/login-screen.tsx",
      "src/app/(auth)/register/register-form.tsx",
      "src/components/settings/account-form.tsx",
      "src/app/verify/page.tsx",
    ]) {
      const text = readFileSync(path.resolve(__dirname, "..", file), "utf8");
      expect(text, file).not.toContain("signInWithRedirect");
      expect(text, file).not.toContain("linkWithRedirect");
      expect(text, file).not.toContain("getRedirectResult");
      expect(text, file).not.toContain("null_redirect_after_pending");
    }
  });

  it("signs in via signInWithPopup, verifies credential.user, mints session once and clears remembered destination", async () => {
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google", { next: "/projects/42" });
    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(mocks.setCustomParameters).toHaveBeenCalledWith({ prompt: "select_account" });
    expect(mocks.mintSessionCookie).toHaveBeenCalledTimes(1);
    expect(mocks.mintSessionCookie).toHaveBeenCalledWith(GOOGLE_CRED.user, undefined);
    expect(result).toMatchObject({
      status: "ok",
      uid: "uid-1",
      provider: "google",
      isNewUser: false,
      operation: "signIn",
      profileLoaded: true,
    });
    expect(oauth.rememberedPostLoginPath()).toBeNull();
  });

  it("supports logging out and signing in with Google again cleanly", async () => {
    const oauth = await loadOAuth();
    const first = await oauth.startOAuthSignIn("google", { next: "/chat" });
    expect(first).toMatchObject({ status: "ok", uid: "uid-1" });
    oauth.clearOAuthFlowMarkers();
    mocks.state.currentUser = null;
    const second = await oauth.startOAuthSignIn("google", { next: "/chat" });
    expect(second).toMatchObject({ status: "ok", uid: "uid-1" });
    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(2);
  });

  it("reports new Google accounts with isNewUser: true", async () => {
    mocks.getAdditionalUserInfo.mockReturnValue({ isNewUser: true });
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google", { next: "/chat" });
    expect(result).toMatchObject({ status: "ok", uid: "uid-1", isNewUser: true, operation: "signIn" });
  });

  it("fails explicitly if signInWithPopup resolves without credential.user", async () => {
    mocks.signInWithPopup.mockResolvedValue({ user: null, providerId: "google.com", operationType: "signIn" });
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("error");
    expect(mocks.mintSessionCookie).not.toHaveBeenCalled();
  });

  it("waits on authStateReady if shared auth.currentUser lags behind popup resolution", async () => {
    mocks.state.currentUser = null;
    mocks.signInWithPopup.mockResolvedValue(GOOGLE_CRED);
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(mocks.authStateReady).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", uid: "uid-1" });
    expect(mocks.mintSessionCookie).toHaveBeenCalledWith(GOOGLE_CRED.user, undefined);
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
    const result = await oauth.startOAuthSignIn("google", { next: "/chat" });
    expect(result).toMatchObject({ status: "ok", uid: "uid-1" });
    expect(oauth.rememberedPostLoginPath()).toBeNull();
  });
});

describe("popup error handling", () => {
  it("handles auth/popup-blocked with a clear user-facing error", async () => {
    mocks.signInWithPopup.mockRejectedValue(Object.assign(new Error("blocked"), { code: "auth/popup-blocked" }));
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toMatch(/blocked the sign-in popup/i);
  });

  it("handles auth/popup-closed-by-user with cancelled status and helpful copy", async () => {
    mocks.signInWithPopup.mockRejectedValue(
      Object.assign(new Error("closed"), { code: "auth/popup-closed-by-user" }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("cancelled");
    expect(result.status === "cancelled" && result.message).toMatch(/popup was closed/i);
  });

  it("handles auth/unauthorized-domain cleanly", async () => {
    mocks.signInWithPopup.mockRejectedValue(
      Object.assign(new Error("domain"), { code: "auth/unauthorized-domain" }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toMatch(/Authorized domains/i);
  });

  it("handles auth/account-exists-with-different-credential cleanly", async () => {
    mocks.signInWithPopup.mockRejectedValue(
      Object.assign(new Error("exists"), { code: "auth/account-exists-with-different-credential" }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toMatch(/email and password/i);
  });

  it("handles auth/network-request-failed cleanly", async () => {
    mocks.signInWithPopup.mockRejectedValue(
      Object.assign(new Error("offline"), { code: "auth/network-request-failed" }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toMatch(/network problem/i);
  });
});

describe("session failures are never reported as Google failures", () => {
  it("labels a rejected Origin (403 BAD_ORIGIN) as a deployment/domain problem", async () => {
    mocks.mintSessionCookie.mockRejectedValue(
      Object.assign(new Error("BAD_ORIGIN: Origin https://qorvyna.thamjj13.top is not allowed"), {
        code: "BAD_ORIGIN",
        status: 403,
      }),
    );
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("session-failed");
    const message = result.status === "session-failed" ? result.message : "";
    expect(message).toMatch(/domain/i);
    expect(message).toMatch(/NEXT_PUBLIC_APP_URL|QORVYNA_ALLOWED_ORIGINS/);
    expect(message).not.toMatch(/couldn't finish google/i);
  });

  it("keeps the retry-session copy for a 500 or profile failure from /api/auth/session", async () => {
    mocks.mintSessionCookie.mockResolvedValue({ ok: true, uid: "uid-1", onboarding_complete: false, profile_loaded: false });
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthSignIn("google");
    expect(result.status).toBe("session-failed");
    expect(result.status === "session-failed" && result.message).toMatch(/Retry session/);
  });
});

describe("account linking over popup", () => {
  it("links via linkWithPopup and refreshes the backend session", async () => {
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthLink("google");
    expect(mocks.linkWithPopup).toHaveBeenCalledTimes(1);
    expect(mocks.mintSessionCookie).toHaveBeenCalledWith(GOOGLE_CRED.user, { forceRefresh: true });
    expect(result).toMatchObject({ status: "ok", operation: "link", provider: "google" });
  });

  it("requires a signed-in user before linking", async () => {
    mocks.state.currentUser = null;
    const oauth = await loadOAuth();
    const result = await oauth.startOAuthLink("google");
    expect(result.status).toBe("error");
    expect(mocks.linkWithPopup).not.toHaveBeenCalled();
  });

  it("emits POPUP_SIGN_IN_STARTED, POPUP_SIGN_IN_COMPLETED, AUTH_USER_DETECTED and AUTH_POPUP_ERROR safely", async () => {
    const oauth = await loadOAuth();
    await oauth.startOAuthSignIn("google");
    const loggedText = warn.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(loggedText).toContain("POPUP_SIGN_IN_STARTED");
    expect(loggedText).toContain("POPUP_SIGN_IN_COMPLETED");
    expect(loggedText).toContain("AUTH_USER_DETECTED");

    warn.mockClear();
    mocks.signInWithPopup.mockRejectedValue(Object.assign(new Error("boom"), { code: "auth/unauthorized-domain" }));
    const oauthErr = await loadOAuth();
    await oauthErr.startOAuthSignIn("google");
    const errText = warn.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(errText).toContain("AUTH_POPUP_ERROR");
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

  it("falls back to the remembered path after sign-in", async () => {
    const oauth = await loadOAuth();
    oauth.rememberPostLoginPath("/workspace");
    expect(oauth.postAuthPath(false, null)).toBe("/workspace");
  });
});
