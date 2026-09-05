import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, isThemeMode } from "@/lib/theme-templates";

// Dark ("Tech AI / Dark Neon") is the PRIMARY theme of MATRIX V3; light
// ("Minimalist Futuristic") is a fully designed alternative, not an inversion.
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
    // Light is not a naive inversion: it defines its own primary that holds
    // contrast on white (neon mint would not).
    const light = tokens.slice(tokens.indexOf('[data-theme="light"]'));
    expect(light).toMatch(/--primary:\s*#00895e/i);
    const dark = tokens.slice(tokens.indexOf('[data-theme="dark"]'));
    expect(dark).toMatch(/--primary:\s*#00f5a0/i);
  });
});
