import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, isThemeMode } from "@/lib/theme-templates";

// Light mode is the PRIMARY theme of the product: every default that ships —
// the client provider, the pre-paint script and the SSR <html> attribute —
// must agree, or users flash/land in dark unexpectedly.
describe("light mode is the default", () => {
  it("declares light as the default theme mode", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(isThemeMode(DEFAULT_THEME)).toBe(true);
  });

  it("root layout renders <html> in light mode before hydration", () => {
    const layout = readFileSync(join(__dirname, "../src/app/layout.tsx"), "utf8");
    expect(layout).toContain('data-theme="light"');
    expect(layout).not.toContain('data-theme="dark"');
  });

  it("pre-paint script falls back to light when nothing is stored", () => {
    const layout = readFileSync(join(__dirname, "../src/app/layout.tsx"), "utf8");
    const script = layout.match(/const THEME_SCRIPT = `([^`]+)`/)?.[1] ?? "";
    expect(script).toContain("localStorage.getItem('matrix-theme')||'light'");
    expect(script).not.toMatch(/\|\|'dark'/);
    expect(script).toContain("data-theme','light'"); // hard fallback in catch
  });

  it("client ThemeProvider defaults to light for fresh visitors", () => {
    const provider = readFileSync(join(__dirname, "../src/lib/theme.tsx"), "utf8");
    expect(provider).not.toMatch(/initialTheme \?\? "dark"/);
    expect(provider).not.toMatch(/: "dark"\);?\s*\/\//); // no casual dark fallback comment style
    expect(provider).toContain("DEFAULT_THEME");
  });

  it("theme cycle starts at light", () => {
    const provider = readFileSync(join(__dirname, "../src/lib/theme.tsx"), "utf8");
    const order = provider.match(/ORDER: Theme\[\] = \[([^\]]+)\]/)?.[1] ?? "";
    expect(order.replace(/[\"'\s]/g, "")).toBe("light,dark,system");
  });
});
