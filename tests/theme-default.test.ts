import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, isThemeMode } from "@/lib/theme-templates";

// Dark (deep navy with the QORVYNA blue → violet accents) is the PRIMARY theme;
// light is a fully designed alternative, not an inversion.
// Every default that ships — the theme-templates constant, the pre-paint
// script and the SSR <html> attribute — must agree, or users get a flash of
// the wrong theme on first paint.
describe("dark mode is the default", () => {
  it("declares dark as the default theme mode", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(isThemeMode(DEFAULT_THEME)).toBe(true);
  });

  it("root layout renders <html> in dark mode before hydration", () => {
    const layout = readFileSync(join(__dirname, "../src/app/layout.tsx"), "utf8");
    expect(layout).toContain('data-theme="dark"');
  });

  it("pre-paint script falls back to dark when nothing is stored", () => {
    const layout = readFileSync(join(__dirname, "../src/app/layout.tsx"), "utf8");
    const script = layout.match(/const THEME_SCRIPT = `([^`]+)`/)?.[1] ?? "";
    expect(script).toContain("localStorage.getItem('matrix-theme')||'dark'");
    expect(script).toContain("data-theme','dark'"); // hard fallback in catch
  });

  it("client ThemeProvider defers to the shared default constant", () => {
    const provider = readFileSync(join(__dirname, "../src/lib/theme.tsx"), "utf8");
    expect(provider).toContain("DEFAULT_THEME");
  });

  it("both themes are defined independently in the token layer", () => {
    const tokens = readFileSync(join(__dirname, "../src/styles/tokens.css"), "utf8");
    expect(tokens).toContain('[data-theme="dark"]');
    expect(tokens).toContain('[data-theme="light"]');
    // Each theme block, up to the next rule.
    const block = (selector: string) => {
      const start = tokens.indexOf(`\n${selector} {`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return tokens.slice(start, tokens.indexOf("\n}", start));
    };
    const dark = block('[data-theme="dark"]');
    const light = block('[data-theme="light"]');
    // The accent as TEXT is tuned per theme: a light blue on navy, and a deeper
    // blue on white — light is not a naive inversion of dark.
    expect(dark).toMatch(/--primary:\s*#6ea0ff/i);
    expect(light).toMatch(/--primary:\s*#1d4fe0/i);
    // The accent as a FILL is the QORVYNA brand blue in both, carrying white.
    for (const theme of [dark, light]) {
      expect(theme).toMatch(/--primary-solid:\s*#2563ff/i);
      expect(theme).toMatch(/--primary-contrast:\s*#ffffff/i);
    }
  });

  it("the brand blue in the token layer is the one in the brand config", async () => {
    const tokens = readFileSync(join(__dirname, "../src/styles/tokens.css"), "utf8");
    const { BRAND_COLORS } = await import("@/lib/brand");
    expect(tokens.toLowerCase()).toContain(`--primary-solid: ${BRAND_COLORS.blue.toLowerCase()}`);
  });
});
