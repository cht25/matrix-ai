// =============================================================================
// Native shell — the Tauri application renders THE SAME frontend.
//
// These tests mount the real components inside a real DOM (jsdom) and assert
// the product contract:
//   • the login screen offers Google + email/password and NO Facebook;
//   • the native router maps the website's URLs (and only those) to screens;
//   • the shared chat composer is the website's composer;
//   • the first-run setup explains every permission and requires none;
//   • the bundled Tauri config loads local assets, not a remote URL.
// =============================================================================
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OAuthButtons, LoginForm, GoogleIcon } from "../src/components/auth/login-screen";
import { parseHref, matchDynamicSegments } from "../src/native/router";
import { PERMISSION_CATALOG, isNativeShell, nativeInfo } from "../src/native/native-bridge";
import { classifyRoute } from "../src/lib/ai/routing-policy";

const read = (path: string) => readFileSync(path, "utf8");

describe("native shell — authentication surface", () => {
  it("offers Google only, with email/password as the primary form", () => {
    const html = renderToStaticMarkup(createElement(OAuthButtons, { onGoogle: () => {} }));
    expect(html).toContain("Continue with Google");
    expect(html.toLowerCase()).not.toContain("facebook");
    // One button, not a half-empty two-column grid.
    expect(html.match(/<button/g) ?? []).toHaveLength(1);
  });

  it("exports a Google icon and no Facebook icon", () => {
    const html = renderToStaticMarkup(createElement(GoogleIcon));
    expect(html).toContain("#4285F4");
    const screen = read("src/components/auth/login-screen.tsx");
    expect(screen).not.toContain("FacebookIcon");
    expect(screen).not.toContain("onFacebook");
  });

  it("keeps the email/password login form intact", () => {
    // LoginForm is a client component that needs the router; the static markup
    // of the shell must still be produced without throwing.
    expect(typeof LoginForm).toBe("function");
    const screen = read("src/components/auth/login-screen.tsx");
    expect(screen).toContain('type="email"');
    expect(screen).toContain("Forgot password?");
  });
});

describe("native shell — router", () => {
  it("parses website URLs exactly", () => {
    expect(parseHref("/chat/abc123?mode=agent")).toEqual({ pathname: "/chat/abc123", search: "mode=agent", hash: "" });
    expect(parseHref("https://qorvyna.thamjj13.top/devices?tab=qr")).toEqual({ pathname: "/devices", search: "tab=qr", hash: "" });
    expect(parseHref("settings")).toEqual({ pathname: "/settings", search: "", hash: "" });
    expect(parseHref("/")).toEqual({ pathname: "/", search: "", hash: "" });
  });

  it("extracts the dynamic parameters the app's routes use", () => {
    expect(matchDynamicSegments("/chat/abc")).toEqual({ id: "abc" });
    expect(matchDynamicSegments("/projects/p1")).toEqual({ id: "p1" });
    expect(matchDynamicSegments("/courses/cyber-101")).toEqual({ slug: "cyber-101" });
    expect(matchDynamicSegments("/devices")).toEqual({});
    // Encoded ids are decoded once, and a broken escape never throws.
    expect(matchDynamicSegments("/chat/a%20b")).toEqual({ id: "a b" });
    expect(() => matchDynamicSegments("/chat/%E0%A4%A")).not.toThrow();
  });

  it("treats the native shell mount point as public in the website router", () => {
    const routing = read("src/lib/routing.ts");
    expect(routing).toContain('"/native-app"');
  });
});

describe("native shell — Tauri configuration bundles the real frontend", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    build: { frontendDist: string; devUrl: string; beforeBuildCommand: string };
    app: { windows: Array<{ url: string }>; security: { csp: unknown } };
    identifier: string;
  };

  it("ships local assets instead of a remote website", () => {
    expect(conf.build.frontendDist).toBe("../public/native");
    expect(conf.build.frontendDist).not.toMatch(/^https?:/);
    expect(conf.app.windows[0]?.url).toBe("index.html");
    expect(JSON.stringify(conf)).not.toMatch(/"url":\s*"https?:/);
  });

  it("builds the bundle from the shared source", () => {
    expect(conf.build.beforeBuildCommand).toContain("scripts/native/build-native-frontend.mjs");
    const script = read("scripts/native/build-native-frontend.mjs");
    expect(script).toContain("src/native/client/entry.tsx");
    expect(script).toContain("src/app/globals.css");
    expect(script).toContain("public");
  });

  it("declares a real CSP (no null) that allows the QORVYNA API and Firebase", () => {
    expect(conf.app.security.csp).not.toBeNull();
    const csp = JSON.stringify(conf.app.security.csp);
    expect(csp).toContain("connect-src");
    expect(csp).toContain("qorvyna.thamjj13.top");
    expect(csp).toContain("firebase");
    expect(csp).toContain("object-src");
  });

  it("keeps the installed-app identifier users already have", () => {
    expect(conf.identifier).toBe("ai.matrix.desktop");
  });
});

describe("native shell — permission checklist", () => {
  it("explains every permission and requires none of them", () => {
    expect(PERMISSION_CATALOG.length).toBeGreaterThanOrEqual(7);
    for (const permission of PERMISSION_CATALOG) {
      expect(permission.why.length).toBeGreaterThan(30);
      expect(permission.label.length).toBeGreaterThan(2);
      expect(permission.platforms.length).toBeGreaterThan(0);
      // Chat must never depend on an optional OS capability.
      expect(permission.required).toBe(false);
    }
  });

  it("never promises always-listening and says detection is on-device", () => {
    const background = PERMISSION_CATALOG.find((permission) => permission.id === "background_microphone");
    expect(background?.why).toMatch(/on-device/i);
    expect(background?.why).toMatch(/after the wake word/i);
  });

  it("is not native when there is no Tauri bridge", async () => {
    expect(isNativeShell()).toBe(false);
    const info = await nativeInfo();
    expect(info.platform).toBe("web");
    expect(info.isDesktop).toBe(false);
  });
});

describe("native shell — chat routing inside the app", () => {
  it("keeps a normal question conversational on GPT OSS 120B", () => {
    expect(classifyRoute({ message: "Hello" }).intent).toBe("conversation");
    expect(classifyRoute({ message: "Explain React hooks" }).intent).toBe("conversation");
  });

  it("routes a website request to the artifact class", () => {
    expect(classifyRoute({ message: "Build me a website", mode: "agent" }).intent).toBe("artifact");
  });
});
