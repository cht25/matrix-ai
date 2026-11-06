// =============================================================================
// MATRIX AI — Dynamic Design Engine: validated design tokens.
//
// Users describe a design in natural language; the engine maps it to a
// STRICTLY VALIDATED token set. Arbitrary CSS/JavaScript is impossible by
// construction: only allowlisted fonts, density scales, sidebar modes,
// radius presets and hex colors (with enforced WCAG contrast) can be emitted.
// =============================================================================

import { z } from "zod";

export const DESIGN_MODES = ["dark", "light"] as const;
export type DesignMode = (typeof DESIGN_MODES)[number];

export const DENSITIES = ["compact", "comfortable", "spacious"] as const;
export type Density = (typeof DENSITIES)[number];

export const SIDEBAR_MODES = ["expanded", "collapsed", "auto"] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];

export const FONT_FAMILIES = ["inter", "manrope", "jetbrains-mono", "system"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const RADIUS_PRESETS = ["none", "sm", "md", "lg", "full"] as const;
export type RadiusPreset = (typeof RADIUS_PRESETS)[number];

export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Colors must be #rgb or #rrggbb hex — nothing else is accepted");

export const designTokensSchema = z.object({
  mode: z.enum(DESIGN_MODES),
  colors: z.object({
    bg: hexColorSchema,
    surface: hexColorSchema,
    ink: hexColorSchema,
    accent: hexColorSchema,
  }),
  density: z.enum(DENSITIES),
  sidebar: z.enum(SIDEBAR_MODES),
  fontFamily: z.enum(FONT_FAMILIES),
  radius: z.enum(RADIUS_PRESETS),
});

export type DesignTokens = z.infer<typeof designTokensSchema>;
export type PartialDesignTokens = {
  mode?: DesignMode;
  colors?: Partial<DesignTokens["colors"]>;
  density?: Density;
  sidebar?: SidebarMode;
  fontFamily?: FontFamily;
  radius?: RadiusPreset;
};

export const DEFAULT_DESIGN_TOKENS: DesignTokens = {
  mode: "dark",
  colors: { bg: "#070b14", surface: "#0d1424", ink: "#f8fafc", accent: "#3b82f6" },
  density: "comfortable",
  sidebar: "auto",
  fontFamily: "inter",
  radius: "md",
};

// --- WCAG contrast -----------------------------------------------------------

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    const short = /^#([0-9a-fA-F]{3})$/.exec(hex);
    if (!short) return 0;
    const expanded = "#" + [...short[1]].map((c) => c + c).join("");
    return relativeLuminance(expanded);
  }
  const int = parseInt(m[1], 16);
  const r = srgbToLinear((int >> 16) & 0xff);
  const g = srgbToLinear((int >> 8) & 0xff);
  const b = srgbToLinear(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_TEXT_CONTRAST = 4.5; // WCAG AA for normal text
export const MIN_ACCENT_CONTRAST = 3.0; // WCAG AA for large/UI accents

export type ContrastIssue = { pair: string; ratio: number; required: number };

/** Validate accessibility of a full token set. Returns issues (empty = pass). */
export function checkContrast(tokens: DesignTokens): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  const text = contrastRatio(tokens.colors.ink, tokens.colors.bg);
  if (text < MIN_TEXT_CONTRAST) issues.push({ pair: "ink/bg", ratio: round2(text), required: MIN_TEXT_CONTRAST });
  const surfaceText = contrastRatio(tokens.colors.ink, tokens.colors.surface);
  if (surfaceText < MIN_TEXT_CONTRAST) issues.push({ pair: "ink/surface", ratio: round2(surfaceText), required: MIN_TEXT_CONTRAST });
  const accent = contrastRatio(tokens.colors.accent, tokens.colors.bg);
  if (accent < MIN_ACCENT_CONTRAST) issues.push({ pair: "accent/bg", ratio: round2(accent), required: MIN_ACCENT_CONTRAST });
  return issues;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Density → spacing multiplier applied to the 4px base grid. */
export function densityScale(density: Density): number {
  return { compact: 0.75, comfortable: 1, spacious: 1.25 }[density];
}

/** Radius preset → px. */
export function radiusPx(preset: RadiusPreset): number {
  return { none: 0, sm: 4, md: 8, lg: 14, full: 9999 }[preset];
}

/** Font allowlist → actual CSS stack (never user-controlled strings). */
export function fontStack(family: FontFamily): string {
  return {
    inter: "Inter, ui-sans-serif, system-ui, sans-serif",
    manrope: "Manrope, Inter, ui-sans-serif, system-ui, sans-serif",
    "jetbrains-mono": "'JetBrains Mono', ui-monospace, monospace",
    system: "ui-sans-serif, system-ui, sans-serif",
  }[family];
}
