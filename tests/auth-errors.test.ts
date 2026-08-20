// Unit tests for the client auth-error mapper — especially the deployment
// misconfiguration cases (CONFIGURATION_NOT_FOUND & friends) that previously
// surfaced as generic "We couldn't sign you in" messages.

import { describe, expect, it } from "vitest";
import { authErrorKind, describeAuthError, isFirebaseConfigError } from "@/lib/firebase/auth-errors";

/** Firebase SDK-shaped error: code + message (+ optional server errorMessage). */
function fbErr(code: string, message = "", errorMessage = ""): unknown {
  return { code, message, ...(errorMessage ? { customData: { errorMessage } } : {}) };
}

describe("authErrorKind", () => {
  it("recognises the exact console failure: CONFIGURATION_NOT_FOUND from Identity Toolkit", () => {
    expect(
      authErrorKind(
        fbErr(
          "auth/internal-error",
          "Firebase: Error (auth/internal-error).",
          "CONFIGURATION_NOT_FOUND",
        ),
      ),
    ).toBe("config");
  });

  it("recognises SDK code spellings for bad keys", () => {
    expect(authErrorKind(fbErr("auth/configuration-not-found"))).toBe("config");
    expect(authErrorKind(fbErr("auth/api-key-not-valid.-please-pass-a-valid-api-key."))).toBe("config");
    expect(authErrorKind(fbErr("auth/invalid-api-key"))).toBe("config");
  });

  it("recognises deployment gating errors", () => {
    expect(authErrorKind(fbErr("auth/unauthorized-domain"))).toBe("domain");
    expect(authErrorKind(fbErr("auth/operation-not-allowed"))).toBe("provider");
  });

  it("never labels a session-mint failure as a generic Google failure", () => {
    expect(authErrorKind(fbErr("SESSION_MINT_FAILED"))).toBe("session");
    expect(describeAuthError(fbErr("SESSION_MINT_FAILED"), "Sign-in with google failed")).toContain("Retry session");
    expect(describeAuthError(fbErr("SESSION_MINT_FAILED"), "Sign-in with google failed")).not.toMatch(/google failed/i);
  });

  it("explains account-exists-with-different-credential", () => {
    expect(authErrorKind(fbErr("auth/account-exists-with-different-credential"))).toBe("account-exists");
    expect(describeAuthError(fbErr("auth/account-exists-with-different-credential"), "fallback")).toContain("already exists");
  });

  it("recognises user-level errors", () => {
    expect(authErrorKind(fbErr("auth/invalid-credential"))).toBe("invalid-credential");
    expect(authErrorKind(fbErr("auth/wrong-password"))).toBe("invalid-credential");
    expect(authErrorKind(fbErr("auth/too-many-requests"))).toBe("rate-limit");
    expect(authErrorKind(fbErr("auth/network-request-failed"))).toBe("network");
  });

  it("falls back to unknown for anything else (incl. non-errors)", () => {
    expect(authErrorKind(fbErr("auth/popup-closed-by-user"))).toBe("unknown");
    expect(authErrorKind(new Error("boom"))).toBe("unknown");
    expect(authErrorKind(null)).toBe("unknown");
    expect(authErrorKind("nope")).toBe("unknown");
  });
});

describe("isFirebaseConfigError", () => {
  it("is true only for operator-fixable configuration failures", () => {
    expect(isFirebaseConfigError(fbErr("auth/configuration-not-found"))).toBe(true);
    expect(isFirebaseConfigError(fbErr("auth/unauthorized-domain"))).toBe(true);
    expect(isFirebaseConfigError(fbErr("auth/operation-not-allowed"))).toBe(true);
    expect(isFirebaseConfigError(fbErr("auth/invalid-credential"))).toBe(false);
    expect(isFirebaseConfigError(undefined)).toBe(false);
  });
});

describe("describeAuthError", () => {
  it("explains CONFIGURATION_NOT_FOUND instead of blaming the user", () => {
    const copy = describeAuthError(
      fbErr("auth/internal-error", "", "CONFIGURATION_NOT_FOUND"),
      "We couldn't sign you in. Please try again.",
    );
    expect(copy).toContain("Server setup problem");
    expect(copy).toContain("NEXT_PUBLIC_FIREBASE_API_KEY");
  });

  it("points unauthorized-domain errors at the console setting", () => {
    const copy = describeAuthError(fbErr("auth/unauthorized-domain"), "fallback");
    expect(copy).toContain("Authorized domains");
  });

  it("returns the caller's fallback for ordinary failures", () => {
    expect(describeAuthError(fbErr("auth/invalid-credential"), "Incorrect email or password.")).toBe(
      "Incorrect email or password.",
    );
    expect(describeAuthError(fbErr("auth/popup-closed-by-user"), "fallback copy")).toBe("fallback copy");
  });
});
