// Dynamic Design Engine: natural language → strictly validated tokens with
// WCAG contrast enforcement. Arbitrary CSS/JS can never be emitted.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_TOKENS,
  checkContrast,
  contrastRatio,
  designTokensSchema,
} from "@/lib/design/tokens";
import {
  buildDesignFromInstruction,
  cssVariables,
  editDesignTokens,
  parseDesignInstruction,
} from "@/lib/design/engine";

describe("contrast math", () => {
  it("computes WCAG ratios (black/white = 21)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 1);
  });
  it("accepts the default palette", () => {
    expect(checkContrast(DEFAULT_DESIGN_TOKENS)).toEqual([]);
  });
  it("flags inaccessible ink", () => {
    const issues = checkContrast({
      ...DEFAULT_DESIGN_TOKENS,
      colors: { ...DEFAULT_DESIGN_TOKENS.colors, ink: "#777777" },
    });
    expect(issues.some((i) => i.pair === "ink/bg")).toBe(true);
  });
});

describe("parseDesignInstruction", () => {
  it("maps the example instruction to validated tokens", () => {
    const changes = parseDesignInstruction(
      "Create a warm white interface with a compact sidebar, elegant typography, soft borders, and a premium minimal appearance.",
    );
    expect(changes.mode).toBe("light");
    expect(changes.sidebar).toBe("collapsed");
    expect(changes.density).toBe("compact");
    expect(changes.fontFamily).toBe("manrope"); // "elegant" → manrope
    expect(changes.radius).toBe("sm"); // "soft" borders
  });
  it("extracts named and positional hex colors", () => {
    const changes = parseDesignInstruction("dark theme, background #0a0a0a, accent #22d3ee and text #eeeeee");
    expect(changes.mode).toBe("dark");
    expect(changes.colors?.bg).toBe("#0a0a0a");
    expect(changes.colors?.accent).toBe("#22d3ee");
    expect(changes.colors?.ink).toBe("#eeeeee");
  });
  it("ignores non-design input", () => {
    expect(parseDesignInstruction("what is the capital of France?")).toEqual({});
  });
});

describe("buildDesignFromInstruction", () => {
  it("builds an accessible custom design", () => {
    const res = buildDesignFromInstruction("warm white interface with compact sidebar");
    expect(res.ok).toBe(true);
    expect(res.tokens?.mode).toBe("light");
    expect(res.tokens?.density).toBe("compact");
    expect(res.tokens?.sidebar).toBe("collapsed");
  });
  it("blocks inaccessible combinations instead of applying them", () => {
    const res = buildDesignFromInstruction("light mode with text #999999 on bg #ffffff");
    expect(res.ok).toBe(false);
    expect(res.contrastIssues.length).toBeGreaterThan(0);
  });
  it("reports unrecognised instructions honestly", () => {
    const res = buildDesignFromInstruction("tell me a joke");
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/No recognizable design instruction/);
  });
});

describe("token safety", () => {
  it("rejects non-hex colors and unknown enum values", () => {
    expect(
      designTokensSchema.safeParse({ ...DEFAULT_DESIGN_TOKENS, colors: { ...DEFAULT_DESIGN_TOKENS.colors, bg: "red; } body { display:none" } }).success,
    ).toBe(false);
    expect(
      designTokensSchema.safeParse({ ...DEFAULT_DESIGN_TOKENS, density: "ultra-dense" }).success,
    ).toBe(false);
  });
  it("emits CSS variables only from validated tokens", () => {
    const vars = cssVariables(DEFAULT_DESIGN_TOKENS);
    expect(vars["--mx-bg"]).toBe("#070b14");
    expect(Object.values(vars).every((v) => !v.includes("{") && !v.includes("}") && !v.includes("javascript"))).toBe(true);
  });
  it("edit path is validated and contrast-gated too", () => {
    const ok = editDesignTokens(DEFAULT_DESIGN_TOKENS, { density: "compact" });
    expect(ok.ok).toBe(true);
    const bad = editDesignTokens(DEFAULT_DESIGN_TOKENS, { colors: { ink: "#555555" } });
    expect(bad.ok).toBe(false);
  });
});
