import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMoreLinks } from "../src/components/mobile-nav";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("mobile navigation has NO hamburger", () => {
  const shell = read("src/components/app-shell.tsx");
  const nav = read("src/components/mobile-nav.tsx");

  it("never imports or renders a hamburger Menu icon", () => {
    for (const source of [shell, nav]) {
      expect(source).not.toMatch(/<Menu\b/);
      expect(source).not.toMatch(/aria-label="Open menu"/);
    }
  });

  it("has no slide-out drawer left over from the old shell", () => {
    expect(shell).not.toContain("drawerOpen");
    expect(shell).not.toContain("drawer-in");
    expect(shell).not.toContain('aria-label="Navigation menu"');
  });

  it("mounts the bottom navigation instead", () => {
    expect(shell).toContain("<MobileNav");
    expect(nav).toContain("bottom-nav");
    expect(nav).toContain("BottomSheet");
  });

  it("keeps the desktop sidebar hidden on mobile", () => {
    expect(shell).toMatch(/app-sidebar[^"]*hidden[^"]*lg:block/);
  });
});

describe("primary bottom navigation", () => {
  const nav = read("src/components/mobile-nav.tsx");

  it("exposes Chat, Agent, Workspace and Private plus More", () => {
    for (const label of ["Chat", "Agent", "Workspace", "Private", "More"]) {
      expect(nav).toContain(`"${label}"`);
    }
  });
});

describe("More menu respects permissions", () => {
  it("hides every admin entry from non-admins", () => {
    const links = buildMoreLinks({ isAdmin: false });
    expect(links.some((l) => l.href.startsWith("/admin"))).toBe(false);
    expect(links.some((l) => l.group === "Admin")).toBe(false);
  });

  it("offers admin tools — including image configuration — to admins", () => {
    const links = buildMoreLinks({ isAdmin: true });
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain("/admin");
    expect(hrefs).toContain("/admin/ai");
    expect(hrefs).toContain("/admin/sites");
  });

  it("collects the secondary features the top bar no longer carries", () => {
    const hrefs = buildMoreLinks({ isAdmin: false }).map((l) => l.href);
    for (const href of ["/settings", "/security", "/courses", "/certificates", "/scanner", "/support"]) {
      expect(hrefs).toContain(href);
    }
  });

  it("gives every entry a label, icon and group", () => {
    for (const link of buildMoreLinks({ isAdmin: true })) {
      expect(link.label.length).toBeGreaterThan(0);
      expect(link.group.length).toBeGreaterThan(0);
      expect(link.icon).toBeTruthy();
    }
  });
});

describe("bottom sheet accessibility", () => {
  const sheet = read("src/components/bottom-sheet.tsx");

  it("is a labelled modal dialog that traps focus and closes on Escape", () => {
    expect(sheet).toContain('role="dialog"');
    expect(sheet).toContain('aria-modal="true"');
    expect(sheet).toContain("aria-label={title}");
    expect(sheet).toContain('event.key === "Escape"');
    expect(sheet).toContain("event.key !== \"Tab\"");
  });

  it("locks background scroll and restores focus on close", () => {
    expect(sheet).toContain('document.body.style.overflow = "hidden"');
    expect(sheet).toContain("restoreFocus.current?.focus?.()");
  });
});

describe("API key never reaches the browser", () => {
  it("the admin image settings component never reads a key back", () => {
    const ui = read("src/components/admin/image-provider-settings.tsx");
    // Strip comments so prose mentioning "localStorage" cannot fail the check.
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/localStorage|sessionStorage/);
    expect(ui).not.toMatch(/api_key\s*:\s*value\.api_key\b/);
    // Only the masked last-4 is ever rendered.
    expect(ui).toContain("api_key_last4");
  });

  it("the public config type carries no secret field", () => {
    const config = read("src/lib/ai/image/config.ts");
    const publicType = config.slice(
      config.indexOf("export type PublicImageProviderConfig"),
      config.indexOf("// --- encryption"),
    );
    expect(publicType).not.toMatch(/\bapi_key\s*:/);
    expect(publicType).toContain("api_key_last4");
    expect(config).toContain("api_key_encrypted");
    expect(config).toContain("aes-256-gcm");
  });

  it("never logs the key in the audit trail", () => {
    const rpcRoute = read("src/app/api/rpc/route.ts");
    const block = rpcRoute.slice(
      rpcRoute.indexOf("admin_image_provider_save"),
      rpcRoute.indexOf("admin_image_provider_test"),
    );
    expect(block).toContain("key_rotated");
    expect(block).not.toMatch(/logAudit\([^)]*api_key\s*[,)]/s);
  });
});
