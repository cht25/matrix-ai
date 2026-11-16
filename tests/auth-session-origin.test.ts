// =============================================================================
// The session boundary after a domain migration.
//
// A new production domain breaks sign-in in a very specific, easy-to-misread
// way: Google succeeds, then `POST /api/auth/session` answers 403 because the
// browser's Origin is not in the deployment's allowlist. These tests pin both
// halves of that contract — the allowlist itself, and the client that must
// report it as a session/domain problem rather than "Google failed".
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublic } from "@/lib/routing";
import { mutationCsrfResponse, mutationOriginAllowed, extraAllowedOrigins } from "@/lib/server/request-security";
import { safeAuthError } from "@/lib/auth/diagnostics";

function request(headers: Record<string, string>, method = "POST") {
  return new Request("https://qorvyna.thamjj13.top/api/auth/session", { method, headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("origin allowlist", () => {
  it("accepts the site's own origin", () => {
    expect(mutationOriginAllowed(request({ Origin: "https://qorvyna.thamjj13.top" }))).toBe(true);
  });

  it("accepts an explicitly configured app origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://qorvyna.thamjj13.top");
    expect(mutationOriginAllowed(request({ Origin: "https://qorvyna.thamjj13.top" }))).toBe(true);
  });

  it("accepts extra exact origins from QORVYNA_ALLOWED_ORIGINS (previous domain, www host)", () => {
    vi.stubEnv("QORVYNA_ALLOWED_ORIGINS", "https://www.qorvyna.thamjj13.top, https://matrix.thamjj13.top");
    expect(extraAllowedOrigins()).toEqual(["https://www.qorvyna.thamjj13.top", "https://matrix.thamjj13.top"]);
    // The request is addressed to another host, so only the list can allow it.
    expect(
      mutationOriginAllowed(request({ Origin: "https://www.qorvyna.thamjj13.top", Host: "internal:10000" })),
    ).toBe(true);
    expect(
      mutationOriginAllowed(request({ Origin: "https://matrix.thamjj13.top", Host: "internal:10000" })),
    ).toBe(true);
    expect(
      mutationOriginAllowed(request({ Origin: "https://other.thamjj13.top", Host: "internal:10000" })),
    ).toBe(false);
  });

  it("still honours the pre-rename MATRIX_ALLOWED_ORIGINS", () => {
    vi.stubEnv("MATRIX_ALLOWED_ORIGINS", "https://old.thamjj13.top");
    expect(extraAllowedOrigins()).toEqual(["https://old.thamjj13.top"]);
  });

  it("never widens the list from malformed entries", () => {
    vi.stubEnv(
      "QORVYNA_ALLOWED_ORIGINS",
      "qorvyna.thamjj13.top,https://x.example/path,ftp://x.example,https://user:pw@x.example,*",
    );
    expect(extraAllowedOrigins()).toEqual([]);
    expect(mutationOriginAllowed(request({ Origin: "https://x.example", Host: "internal:10000" }))).toBe(false);
  });

  it("rejects lookalike hosts, wrong schemes, ports and the null origin", () => {
    for (const origin of [
      "https://qorvyna.thamjj13.top.evil.example",
      "http://qorvyna.thamjj13.top",
      "https://qorvyna.thamjj13.top:8443",
      "null",
      "",
    ]) {
      expect(mutationOriginAllowed(request({ Origin: origin })), origin).toBe(false);
    }
  });

  it("reports the real code and the allowed origins in the 403 body", async () => {
    const response = mutationCsrfResponse(request({ Origin: "https://attacker.example" }));
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_ORIGIN");
    expect(body.error.message).toContain("https://qorvyna.thamjj13.top");
  });

  it("does not police safe methods", () => {
    expect(mutationOriginAllowed(request({ Origin: "https://attacker.example" }, "GET"))).toBe(true);
  });
});

describe("session cookie client", () => {
  const mocks = vi.hoisted(() => ({ getIdToken: vi.fn() }));

  beforeEach(() => {
    mocks.getIdToken.mockResolvedValue("id-token");
  });

  it("keeps BAD_ORIGIN (403) instead of degrading it to SESSION_MINT_FAILED", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/client", () => ({
      fbAuth: () => ({ currentUser: { uid: "uid-1", getIdToken: mocks.getIdToken } }),
    }));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: "BAD_ORIGIN", message: "Origin https://attacker.example is not allowed for this deployment." },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { mintSessionCookie, RpcCallError } = await import("@/lib/client/api");
    const err = await mintSessionCookie().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcCallError);
    expect((err as { code: string }).code).toBe("BAD_ORIGIN");
    expect((err as { status: number }).status).toBe(403);
    expect((err as Error).message).toContain("not allowed for this deployment");
    vi.doUnmock("@/lib/firebase/client");
    vi.unstubAllGlobals();
  });

  it("keeps SESSION_MINT_FAILED (500) and its operator hint", async () => {
    vi.resetModules();
    vi.doMock("@/lib/firebase/client", () => ({
      fbAuth: () => ({ currentUser: { uid: "uid-1", getIdToken: mocks.getIdToken } }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "SESSION_MINT_FAILED", message: "Check FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY." },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { mintSessionCookie } = await import("@/lib/client/api");
    const err = await mintSessionCookie().catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("SESSION_MINT_FAILED");
    expect((err as Error).message).toContain("FIREBASE_CLIENT_EMAIL");
    vi.doUnmock("@/lib/firebase/client");
    vi.unstubAllGlobals();
  });
});

describe("diagnostic redaction", () => {
  it("copies codes and messages but never credential material", () => {
    const error = Object.assign(new Error("Firebase: Error (auth/popup-closed-by-user)."), {
      code: "auth/popup-closed-by-user",
      status: 400,
      credential: { accessToken: "ya29.SECRET", idToken: "eyJ.SECRET" },
      customData: { email: "user@example.com", errorMessage: "CONFIGURATION_NOT_FOUND" },
      idToken: "eyJ.SECRET",
    });
    const safe = safeAuthError(error);
    const serialized = JSON.stringify(safe);
    expect(safe.code).toBe("auth/popup-closed-by-user");
    expect(safe.status).toBe(400);
    expect(safe.providerMessage).toBe("CONFIGURATION_NOT_FOUND");
    expect(safe.customDataKeys).toEqual(["email", "errorMessage"]);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("user@example.com");
    expect(Object.keys(safe)).not.toContain("credential");
    expect(Object.keys(safe)).not.toContain("idToken");
  });

  it("truncates runaway messages", () => {
    const safe = safeAuthError({ code: "x", message: "a".repeat(5000) });
    expect(safe.message.length).toBeLessThanOrEqual(401);
  });

  it("survives non-object errors", () => {
    expect(safeAuthError("boom").message).toBe("boom");
    expect(safeAuthError(undefined).code).toBe("");
  });
});

describe("reverse-proxy wiring", () => {
  it("rewrites /__/auth/* to the proxy route (App Router cannot serve a _-prefixed segment)", () => {
    const config = readFileSync(path.resolve(__dirname, "../next.config.ts"), "utf8");
    expect(config).toContain('source: "/__/auth/:path*"');
    expect(config).toContain('destination: "/api/auth/firebase-handler/:path*"');
    expect(
      existsSync(path.resolve(__dirname, "../src/app/api/auth/firebase-handler/[[...path]]/route.ts")),
    ).toBe(true);
    // The auth helper must be reachable without a session.
    expect(isPublic("/__/auth/handler")).toBe(true);
    expect(isPublic("/__/auth/iframe")).toBe(true);
  });

  it("recovers INVALID_TOKEN once via forced ID token refresh and fails loudly on profile_loaded: false", async () => {
    vi.resetModules();
    const getIdToken = vi.fn().mockResolvedValueOnce("stale-token").mockResolvedValueOnce("fresh-token");
    vi.doMock("@/lib/firebase/client", () => ({
      fbAuth: () => ({ currentUser: { uid: "uid-1", getIdToken } }),
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "INVALID_TOKEN", message: "expired" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, uid: "uid-1", onboarding_complete: false, profile_loaded: false, profile_error: "PROFILE_PROVISION_FAILED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { mintSessionCookie, RpcCallError } = await import("@/lib/client/api");
    const err = await mintSessionCookie().catch((e: unknown) => e);
    expect(getIdToken).toHaveBeenNthCalledWith(1, false);
    expect(getIdToken).toHaveBeenNthCalledWith(2, true);
    expect(err).toBeInstanceOf(RpcCallError);
    expect((err as { code: string }).code).toBe("PROFILE_PROVISION_FAILED");
    vi.doUnmock("@/lib/firebase/client");
    vi.unstubAllGlobals();
  });

  it("decodes UTF-8 non-ASCII JWT names in middleware without failing", async () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, name: "তানজিদ" }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const jwt = `header.${payload}.sig`;
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://qorvyna.thamjj13.top/login", {
      headers: { cookie: `__session=${jwt}` },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/chat");
  });

  it("drops set-cookie from upstream forEach in firebase-handler proxy and clears only invalid cookies with relative Location in clear-session", async () => {
    const proxyCode = readFileSync(
      path.resolve(__dirname, "../src/app/api/auth/firebase-handler/[[...path]]/route.ts"),
      "utf8",
    );
    expect(proxyCode).toContain('"set-cookie"');

    vi.resetModules();
    const verifySession = vi
      .fn()
      .mockRejectedValueOnce(new Error("expired"))
      .mockResolvedValueOnce({ uid: "uid-1" });
    vi.doMock("@/lib/firebase/session", () => ({
      SESSION_COOKIE: "__session",
      sessionCookieOptions: () => ({ httpOnly: true, sameSite: "lax", path: "/" }),
      verifySession,
    }));
    const { GET } = await import("@/app/api/auth/clear-session/route");

    const invalidReq = new NextRequest("http://0.0.0.0:3000/api/auth/clear-session?next=/login", {
      headers: { cookie: "__session=bad-token" },
    });
    const resInvalid = await GET(invalidReq);
    expect(resInvalid.status).toBe(307);
    expect(resInvalid.headers.get("location")).toBe("/login");
    expect(resInvalid.headers.get("set-cookie")).toContain("__session=");
    expect(resInvalid.headers.get("set-cookie")).toContain("Max-Age=0");

    const validReq = new NextRequest("http://0.0.0.0:3000/api/auth/clear-session?next=/settings", {
      headers: { cookie: "__session=good-token" },
    });
    const resValid = await GET(validReq);
    expect(resValid.status).toBe(307);
    expect(resValid.headers.get("location")).toBe("/settings");
    expect(resValid.headers.get("set-cookie")).toBeNull();
    vi.doUnmock("@/lib/firebase/session");
  });
});
