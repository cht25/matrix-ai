import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { internalLocation, isAuthPage, isPublic, pathMatches } from "../src/lib/routing";

describe("pathMatches", () => {
  it("treats '/' as exact — never a prefix of every URL", () => {
    expect(pathMatches("/", "/")).toBe(true);
    expect(pathMatches("/login", "/")).toBe(false);
    expect(pathMatches("/chat", "/")).toBe(false);
  });

  it("matches an entry and its subpaths only", () => {
    expect(pathMatches("/docs", "/docs")).toBe(true);
    expect(pathMatches("/docs/introduction", "/docs")).toBe(true);
    expect(pathMatches("/docs-extra", "/docs")).toBe(false);
    expect(pathMatches("/login", "/login")).toBe(true);
    expect(pathMatches("/login/callback", "/login")).toBe(true);
  });
});

describe("isPublic", () => {
  it("allows the homepage and auth screens without a session", () => {
    expect(isPublic("/")).toBe(true);
    expect(isPublic("/login")).toBe(true);
    expect(isPublic("/register")).toBe(true);
    expect(isPublic("/forgot-password")).toBe(true);
    expect(isPublic("/reset-password")).toBe(true);
    expect(isPublic("/docs/introduction")).toBe(true);
    expect(isPublic("/scams/phishing")).toBe(true);
    expect(isPublic("/certificate/verify/abc")).toBe(true);
    expect(isPublic("/s/my-site")).toBe(true);
  });

  it("does not treat app routes as public", () => {
    expect(isPublic("/chat")).toBe(false);
    expect(isPublic("/dashboard")).toBe(false);
    expect(isPublic("/admin")).toBe(false);
    expect(isPublic("/settings")).toBe(false);
  });
});

describe("isAuthPage", () => {
  it("identifies sign-in / register screens", () => {
    expect(isAuthPage("/login")).toBe(true);
    expect(isAuthPage("/register")).toBe(true);
    expect(isAuthPage("/")).toBe(false);
    expect(isAuthPage("/chat")).toBe(false);
  });
});

describe("internalLocation", () => {
  it("emits a relative path so redirects cannot change host", () => {
    expect(internalLocation("/login", { next: "/chat" })).toBe("/login?next=%2Fchat");
    expect(internalLocation("/chat")).toBe("/chat");
  });

  it("collapses protocol-relative hosts into a same-origin path", () => {
    expect(internalLocation("//thamjj13.top/login")).toBe("/thamjj13.top/login");
    expect(internalLocation("//thamjj13.top/login").startsWith("//")).toBe(false);
  });
});

describe("middleware static-asset exclusions", () => {
  // The matcher in src/middleware.ts must let static files through untouched.
  // Googlebot fetches the Search Console verification file logged out — a
  // 307 to /login fails HTML-file verification, so `.html` must be excluded.
  const source = readFileSync(path.resolve(__dirname, "../src/middleware.ts"), "utf8");
  const literal = source.match(/matcher:\s*\[\s*("(?:[^"\\]|\\.)*")/)?.[1] ?? '""';
  const matcher = new RegExp(`^${JSON.parse(literal)}$`);

  it("excludes .html files (Google site verification) from auth redirects", () => {
    expect(matcher.test("/google2c32b414ac39f412.html")).toBe(false);
  });

  it("still guards page routes", () => {
    expect(matcher.test("/chat")).toBe(true);
    expect(matcher.test("/dashboard")).toBe(true);
  });

  it("does not bounce /admin from unverified JWT admin claims", () => {
    // Real admins often have a Firestore assignment before the session cookie
    // carries `admin`/`role` custom claims. Middleware used to 307 them to /chat.
    expect(source).not.toMatch(/pathname\.startsWith\("\/admin"\)/);
  });

  it("ships the Google verification file where Next.js serves it (public/)", () => {
    expect(existsSync(path.resolve(__dirname, "../public/google2c32b414ac39f412.html"))).toBe(true);
  });
});
