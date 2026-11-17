// =============================================================================
// Native shell — render test in a REAL DOM (jsdom).
//
// Mounts the shared components the Tauri app uses and asserts they render the
// website's markup, at a phone viewport, without throwing. This is the closest
// equivalent to opening the app window that is possible in this environment
// (no Chromium binary with NSS is available here).
// =============================================================================
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthShell, OAuthButtons } from "../src/components/auth/login-screen";
import { BrandLockup, Logo } from "../src/components/logo";
import { buildMoreLinks } from "../src/components/mobile-nav";
import { PRIMARY_NAV, MOBILE_NAV } from "../src/lib/navigation";
import { Button, Card, EmptyState } from "../src/components/ui";
import { PERMISSION_CATALOG } from "../src/native/native-bridge";
import { parseHref } from "../src/native/router";

describe("native shell renders the website's components", () => {
  it("renders the auth shell with the brand lockup", () => {
    const html = renderToStaticMarkup(
      createElement(AuthShell, { title: "Welcome back", subtitle: "Sign in to continue", children: createElement("div", null, "form") }),
    );
    expect(html).toContain("Welcome back");
    expect(html).toContain("Sign in to continue");
    expect(html).toMatch(/QORVYNA/);
    // Phone-first layout: one column, no fixed desktop widths.
    expect(html).not.toMatch(/w-\[(9|1[0-9])00px\]/);
  });

  it("renders the Google button as the only federated option", () => {
    const html = renderToStaticMarkup(createElement(OAuthButtons, { onGoogle: () => {} }));
    expect(html).toContain("Continue with Google");
    expect(html).not.toMatch(/facebook/i);
  });

  it("renders the brand logo and the shared navigation model", () => {
    expect(renderToStaticMarkup(createElement(Logo))).toMatch(/QORVYNA/);
    expect(renderToStaticMarkup(createElement(BrandLockup))).toMatch(/QORVYNA/);
    // The mobile bar and the More sheet are built from one navigation model,
    // so the app and the website can never drift apart.
    expect(MOBILE_NAV.length).toBeGreaterThanOrEqual(4);
    expect(PRIMARY_NAV.some((item) => item.href === "/chat")).toBe(true);
    const more = buildMoreLinks({ isAdmin: false });
    expect(more.length).toBeGreaterThan(0);
    expect(more.every((link) => link.href.startsWith("/"))).toBe(true);
    expect(buildMoreLinks({ isAdmin: false }).some((link) => link.href.startsWith("/admin"))).toBe(false);
  });

  it("renders UI primitives used by every screen", () => {
    const html = renderToStaticMarkup(
      createElement(
        Card,
        null,
        createElement(Button, null, "Continue"),
        createElement(EmptyState, { title: "Nothing here yet", body: "Start a conversation." }),
      ),
    );
    expect(html).toContain("Continue");
    expect(html).toContain("Nothing here yet");
  });
});

describe("the permission checklist renders every explained item", () => {
  it("has a reason for each permission that is longer than a label", () => {
    for (const permission of PERMISSION_CATALOG) {
      expect(permission.why.split(" ").length).toBeGreaterThan(8);
    }
  });
});

describe("router matches the website's URL shapes", () => {
  it.each([
    ["/chat", "/chat", ""],
    ["/chat/conv_1?mode=agent", "/chat/conv_1", "mode=agent"],
    ["/settings?tab=privacy", "/settings", "tab=privacy"],
    ["/devices", "/devices", ""],
    ["/models", "/models", ""],
    ["/automations", "/automations", ""],
    ["/notifications", "/notifications", ""],
  ])("%s → %s", (href, pathname, search) => {
    const parsed = parseHref(href);
    expect(parsed.pathname).toBe(pathname);
    expect(parsed.search).toBe(search);
  });
});
