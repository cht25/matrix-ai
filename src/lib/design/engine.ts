// =============================================================================
// MATRIX AI — Dynamic Design Engine: deterministic natural-language → tokens.
//
// Like the theme gallery, this is intentionally deterministic (no LLM): a
// description is mapped by keyword rules onto the validated token schema from
// tokens.ts, merged over the current/default config, then checked for WCAG
// contrast. The result can be previewed, edited, and only persisted after the
// user approves it (server side, in Firestore, with version history).
// =============================================================================

import {
  DEFAULT_DESIGN_TOKENS,
  checkContrast,
  densityScale,
  fontStack,
  radiusPx,
  designTokensSchema,
  type DesignTokens,
  type Density,
  type SidebarMode,
  type FontFamily,
  type RadiusPreset,
  type PartialDesignTokens,
  type ContrastIssue,
} from "@/lib/design/tokens";

export type DesignBuildResult = {
  ok: boolean;
  tokens?: DesignTokens;
  /** Tokens actually changed by this instruction. */
  changes: PartialDesignTokens;
  /** WCAG issues that blocked the design (empty when ok). */
  contrastIssues: ContrastIssue[];
  /** Human-readable summary for the preview card. */
  summary: string;
};

const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

// Keyword tables — each entry maps natural language to a validated token.
const MODE_KEYWORDS: Array<[RegExp, "dark" | "light"]> = [
  [/\b(dark|midnight|black|night|carbon)\b/i, "dark"],
  [/\b(light|white|bright|day|paper|ivory|warm white)\b/i, "light"],
];
const DENSITY_KEYWORDS: Array<[RegExp, Density]> = [
  [/\b(compact|tight|dense|small)\b/i, "compact"],
  [/\b(spacious|roomy|airy|relaxed|loose)\b/i, "spacious"],
  [/\b(comfortable|default|normal|standard)\b/i, "comfortable"],
];
const SIDEBAR_KEYWORDS: Array<[RegExp, SidebarMode]> = [
  [/\bsidebar\s+(collapsed|hidden|icon[- ]only|minimal)\b|\b(collapse(?:d)?|compact|minimal|hide)\s+sidebar\b|\bcompact\s+sidebar\b/i, "collapsed"],
  [/\bsidebar\s+(expanded|always|visible|wide)\b|\bexpand(?:ed)?\s+sidebar\b/i, "expanded"],
  [/\bauto(?:matic)?\s+sidebar\b/i, "auto"],
];
const FONT_KEYWORDS: Array<[RegExp, FontFamily]> = [
  [/\b(jetbrains|mono(?:space)?|code)\s*(?:font|typography)?\b/i, "jetbrains-mono"],
  [/\bmanrope\b/i, "manrope"],
  [/\b(inter|system|sans)\b/i, "inter"],
];
const RADIUS_KEYWORDS: Array<[RegExp, RadiusPreset]> = [
  [/\b(sharp|square|no|zero)\s*(?:corner|radius|border[- ]radius)\b|\bflat\b/i, "none"],
  [/\b(soft|rounded|slightly rounded|gentle)\b/i, "sm"],
  [/\b(pill|fully rounded|full(?:y)? rounded)\b/i, "full"],
  [/\b(large|big|very rounded)\s*(?:corner|radius)?\b/i, "lg"],
];

/** "elegant typography" / "premium minimal" style descriptors → font choice. */
const ELEGANT_RE = /\b(elegant|editorial|premium|refined|classy)\b/i;

/**
 * Parse a natural-language design instruction into partial tokens.
 * Deterministic and bounded: unknown input yields no changes.
 */
export function parseDesignInstruction(input: string): PartialDesignTokens {
  const text = input.slice(0, 500);
  const changes: PartialDesignTokens = {};
  const colors: Partial<DesignTokens["colors"]> = {};

  for (const [re, mode] of MODE_KEYWORDS) if (re.test(text)) changes.mode = mode;
  for (const [re, density] of DENSITY_KEYWORDS) if (re.test(text)) changes.density = density;
  for (const [re, sidebar] of SIDEBAR_KEYWORDS) if (re.test(text)) changes.sidebar = sidebar;
  for (const [re, radius] of RADIUS_KEYWORDS) if (re.test(text)) changes.radius = radius;
  for (const [re, font] of FONT_KEYWORDS) if (re.test(text)) changes.fontFamily = font;
  if (ELEGANT_RE.test(text) && !changes.fontFamily) changes.fontFamily = "manrope";

  // Explicit hex colors: first bg/surface/ink/accent mentions in order of the
  // keywords that precede them; otherwise assign in document order to
  // bg → surface → ink → accent slots that were not named explicitly.
  const hexes = text.match(HEX_RE) ?? [];
  if (hexes.length) {
    const named: Array<["bg" | "surface" | "ink" | "accent", string]> = [];
    const re = /(bg|background|surface|card|ink|text|accent|highlight|primary)\w*[^#]{0,20}(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1].toLowerCase();
      const hex = m[2].toLowerCase();
      if (key.startsWith("bg") || key.startsWith("background")) named.push(["bg", hex]);
      else if (key.startsWith("surface") || key.startsWith("card")) named.push(["surface", hex]);
      else if (key.startsWith("ink") || key.startsWith("text")) named.push(["ink", hex]);
      else named.push(["accent", hex]);
    }
    const fallbackOrder: Array<"bg" | "surface" | "ink" | "accent"> = ["bg", "surface", "ink", "accent"];
    let fi = 0;
    for (const hex of hexes.map((h) => h.toLowerCase())) {
      const explicit = named.find(([, h]) => h === hex);
      if (explicit) colors[explicit[0]] = hex;
      else {
        while (fi < fallbackOrder.length && colors[fallbackOrder[fi]]) fi++;
        if (fi < fallbackOrder.length) colors[fallbackOrder[fi]] = hex;
      }
    }
    if (Object.keys(colors).length) changes.colors = colors;
  }

  return changes;
}

/** Merge partial changes over a base config and validate the full result. */
export function buildDesignTokens(base: DesignTokens, changes: PartialDesignTokens): DesignTokens {
  const merged: DesignTokens = {
    ...base,
    ...changes,
    colors: { ...base.colors, ...(changes.colors ?? {}) },
  };
  return designTokensSchema.parse(merged);
}

/**
 * Full pipeline: instruction → changes → merged tokens → contrast gate.
 * Never throws for bad input; reports issues instead (honest preview).
 */
export function buildDesignFromInstruction(input: string, base: DesignTokens = DEFAULT_DESIGN_TOKENS): DesignBuildResult {
  const changes = parseDesignInstruction(input);
  if (!changes.mode && !changes.colors && !changes.density && !changes.sidebar && !changes.fontFamily && !changes.radius) {
    return { ok: false, changes, contrastIssues: [], summary: "No recognizable design instruction found. Try e.g. “warm white interface with a compact sidebar”." };
  }
  let tokens: DesignTokens;
  try {
    tokens = buildDesignTokens(base, changes);
  } catch {
    return { ok: false, changes, contrastIssues: [], summary: "The requested combination is not a valid design configuration." };
  }
  const contrastIssues = checkContrast(tokens);
  if (contrastIssues.length) {
    return { ok: false, changes, contrastIssues, summary: `Blocked by accessibility: ${contrastIssues.map((i) => `${i.pair} contrast ${i.ratio}:1 (needs ${i.required}:1)`).join("; ")}.` };
  }
  return { ok: true, tokens, changes, contrastIssues: [], summary: describeTokens(tokens) };
}

/** Edit tokens directly (from the preview editor) — still validated + gated. */
export function editDesignTokens(base: DesignTokens, changes: PartialDesignTokens): DesignBuildResult {
  let tokens: DesignTokens;
  try {
    tokens = buildDesignTokens(base, changes);
  } catch {
    return { ok: false, changes, contrastIssues: [], summary: "Invalid token edit." };
  }
  const contrastIssues = checkContrast(tokens);
  if (contrastIssues.length) {
    return { ok: false, changes, contrastIssues, summary: "Contrast check failed." };
  }
  return { ok: true, tokens, changes, contrastIssues: [], summary: describeTokens(tokens) };
}

export function describeTokens(t: DesignTokens): string {
  return [
    `${t.mode} mode`,
    `bg ${t.colors.bg}`,
    `surface ${t.colors.surface}`,
    `ink ${t.colors.ink}`,
    `accent ${t.colors.accent}`,
    `${t.density} density (×${densityScale(t.density)})`,
    `${t.sidebar} sidebar`,
    `${t.fontFamily} type`,
    `${t.radius} corners (${radiusPx(t.radius)}px)`,
  ].join(" · ");
}

export function cssVariables(t: DesignTokens): Record<string, string> {
  // Emitted ONLY from validated tokens — never from raw user text.
  return {
    "--mx-bg": t.colors.bg,
    "--mx-surface": t.colors.surface,
    "--mx-ink": t.colors.ink,
    "--mx-accent": t.colors.accent,
    "--mx-space-scale": String(densityScale(t.density)),
    "--mx-radius": `${radiusPx(t.radius)}px`,
    "--mx-font": fontStack(t.fontFamily),
  };
}
