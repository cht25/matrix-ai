// =============================================================================
// MATRIX — Website Design Intelligence (design-planning stage of the Agent)
//
// The Agent used to hand every website request to the coding model with a
// prompt that said nothing about visual design, so each model fell back to its
// own "default landing page" (blue gradient hero, three cards, same nav), and
// every site looked alike. Follow-up edits were additionally told
// "do not redesign the site".
//
// This module produces a per-project **Design Specification** BEFORE code is
// generated. It is not a template library: there is no HTML here. It reasons
// over independent design axes (direction, palette, typography, layout,
// navigation, components, motion, accessibility) and
//
//   1. honours everything the user actually said (colours, fonts, mood, pages),
//   2. picks an industry-appropriate direction for what they did not say,
//   3. varies the remaining free choices per project (seeded), so two sites in
//      the same category do not converge on one look,
//   4. guarantees WCAG AA contrast for the palette it emits,
//   5. can be refined by the model itself (`mergeModelDesignSpec`) — the
//      model's proposal is validated and contrast-checked, never trusted raw.
//
// Pure + deterministic for a given (brief, seed): no network, no React,
// no Firestore. Unit tested in tests/site-design-spec.test.ts.
// =============================================================================

import { z } from "zod";
import { contrastRatio } from "@/lib/design/tokens";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SITE_INDUSTRIES = [
  "saas", "education", "ecommerce", "portfolio", "corporate", "healthcare", "dashboard",
  "restaurant", "news", "agency", "realestate", "fitness", "travel", "finance", "nonprofit",
  "event", "blog", "legal", "beauty", "developer", "game", "general",
] as const;
export type SiteIndustry = (typeof SITE_INDUSTRIES)[number];

export type SitePalette = {
  mode: "light" | "dark";
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  accent: string;
};

export type SiteTypography = {
  heading: string;
  body: string;
  /** Google Fonts families to load (empty = system stack only). */
  googleFonts: string[];
  scale: "compact" | "balanced" | "dramatic";
  headingWeight: number;
  headingTracking: "tight" | "normal" | "wide";
  headingCase: "normal" | "uppercase";
};

export type SiteDesignSpec = {
  version: 1;
  /** What the site is for, in one sentence. */
  purpose: string;
  industry: SiteIndustry;
  audience: string;
  brand: string;
  /** Named direction + a sentence of art direction. */
  direction: { name: string; summary: string };
  palette: SitePalette;
  typography: SiteTypography;
  layout: {
    hero: string;
    sectionRhythm: string;
    grid: string;
    density: "airy" | "balanced" | "dense";
    maxWidth: string;
    radius: "none" | "sm" | "md" | "lg" | "xl" | "full";
    surfaces: string;
  };
  navigation: { style: string; mobile: string };
  components: string[];
  pages: string[];
  features: string[];
  imagery: string;
  responsive: string[];
  animation: string;
  accessibility: string[];
  /** Things the user explicitly asked for — these outrank every default. */
  userConstraints: string[];
  /** Reference sites / looks the user mentioned. */
  references: string[];
  /** How this spec was produced. */
  source: "heuristic" | "model-refined";
  seed: string;
};

export type BriefAnalysis = {
  industry: SiteIndustry;
  industryConfidence: number;
  purpose: string;
  audience: string;
  brand: string;
  colors: { hex: string; role: "background" | "primary" | "accent" | "text" | "any"; name: string }[];
  mode: "light" | "dark" | null;
  fonts: string[];
  moods: string[];
  pages: string[];
  features: string[];
  references: string[];
  constraints: string[];
};

// ---------------------------------------------------------------------------
// Seeded choice
// ---------------------------------------------------------------------------

function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, well-distributed, deterministic. */
export function seededRandom(seed: string): () => number {
  let a = hash32(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const value = lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * value).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const full = normalizeHex(hex) ?? "#000000";
  const r = parseInt(full.slice(1, 3), 16) / 255;
  const g = parseInt(full.slice(3, 5), 16) / 255;
  const b = parseInt(full.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

export function normalizeHex(value: string): string | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) return null;
  const raw = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${raw.toLowerCase()}`;
}

/** Move lightness away from `against` until the ratio is met (or the gamut ends). */
export function ensureContrast(color: string, against: string, ratio: number): string {
  if (contrastRatio(color, against) >= ratio) return color;
  const { h, s, l } = hexToHsl(color);
  const againstL = hexToHsl(against).l;
  const direction = againstL > 50 ? -1 : 1;
  let best = color;
  for (let step = 1; step <= 50; step += 1) {
    const next = l + direction * step * 2;
    if (next < 0 || next > 100) break;
    best = hslToHex(h, s, next);
    if (contrastRatio(best, against) >= ratio) return best;
  }
  // Could not reach the ratio in that direction (already near the edge).
  return againstL > 50 ? "#0b0b0c" : "#ffffff";
}

function readableOn(color: string): string {
  return contrastRatio("#ffffff", color) >= 4.5 ? "#ffffff" : contrastRatio("#0b0b0c", color) >= 4.5 ? "#0b0b0c" : contrastRatio("#ffffff", color) >= contrastRatio("#0b0b0c", color) ? "#ffffff" : "#0b0b0c";
}

/** Palette contrast problems (empty = AA for text and UI). */
export function paletteIssues(p: SitePalette): string[] {
  const issues: string[] = [];
  const check = (name: string, fg: string, bg: string, min: number) => {
    const ratio = contrastRatio(fg, bg);
    if (ratio < min) issues.push(`${name} ${ratio.toFixed(2)}:1 < ${min}:1`);
  };
  check("text/background", p.text, p.background, 4.5);
  check("text/surface", p.text, p.surface, 4.5);
  check("muted/background", p.muted, p.background, 4.5);
  check("onPrimary/primary", p.onPrimary, p.primary, 4.5);
  check("primary/background", p.primary, p.background, 3);
  check("accent/background", p.accent, p.background, 3);
  return issues;
}

/** Repair any palette so it passes `paletteIssues`. Hue and intent are kept. */
export function repairPalette(input: SitePalette): SitePalette {
  const p = { ...input };
  p.text = ensureContrast(p.text, p.background, 7);
  p.text = ensureContrast(p.text, p.surface, 4.5);
  p.muted = ensureContrast(p.muted, p.background, 4.5);
  p.primary = ensureContrast(p.primary, p.background, 3);
  p.accent = ensureContrast(p.accent, p.background, 3);
  p.onPrimary = readableOn(p.primary);
  if (contrastRatio(p.onPrimary, p.primary) < 4.5) {
    p.primary = ensureContrast(p.primary, p.onPrimary, 4.5);
    p.primary = ensureContrast(p.primary, p.background, 3);
    p.onPrimary = readableOn(p.primary);
  }
  return p;
}

type PaletteRecipe = {
  /** Background temperature and depth. */
  ground: "paper" | "white" | "tinted" | "ink" | "deep" | "charcoal";
  /** How the accent relates to the primary hue. */
  harmony: "analogous" | "complementary" | "split" | "triadic" | "mono";
  saturation: "muted" | "balanced" | "vivid";
};

function buildPalette(primaryHue: number, mode: "light" | "dark", recipe: PaletteRecipe, overrides: Partial<SitePalette> = {}): SitePalette {
  const sat = recipe.saturation === "muted" ? 38 : recipe.saturation === "vivid" ? 84 : 62;
  const accentHue = primaryHue + (recipe.harmony === "analogous" ? 32 : recipe.harmony === "complementary" ? 180 : recipe.harmony === "split" ? 150 : recipe.harmony === "triadic" ? 120 : 0);
  let palette: SitePalette;
  if (mode === "light") {
    const background = recipe.ground === "paper" ? hslToHex(primaryHue + 30, 28, 96.5)
      : recipe.ground === "tinted" ? hslToHex(primaryHue, 30, 97) : "#ffffff";
    palette = {
      mode,
      background,
      surface: recipe.ground === "white" ? hslToHex(primaryHue, 20, 97) : "#ffffff",
      text: hslToHex(primaryHue, recipe.ground === "paper" ? 18 : 24, 11),
      muted: hslToHex(primaryHue, 10, 38),
      border: hslToHex(primaryHue, 16, 88),
      primary: hslToHex(primaryHue, sat, recipe.saturation === "muted" ? 34 : 42),
      onPrimary: "#ffffff",
      accent: hslToHex(accentHue, recipe.harmony === "mono" ? sat - 20 : sat, recipe.harmony === "mono" ? 26 : 44),
    };
  } else {
    const background = recipe.ground === "charcoal" ? hslToHex(primaryHue, 6, 9)
      : recipe.ground === "deep" ? hslToHex(primaryHue, 42, 8) : hslToHex(primaryHue + 20, 22, 6);
    palette = {
      mode,
      background,
      surface: recipe.ground === "charcoal" ? hslToHex(primaryHue, 6, 13) : hslToHex(primaryHue, 30, 12),
      text: hslToHex(primaryHue, 18, 95),
      muted: hslToHex(primaryHue, 12, 68),
      border: hslToHex(primaryHue, 16, 22),
      primary: hslToHex(primaryHue, sat, 62),
      onPrimary: "#0b0b0c",
      accent: hslToHex(accentHue, recipe.harmony === "mono" ? sat - 16 : sat, recipe.harmony === "mono" ? 78 : 66),
    };
  }
  return repairPalette({ ...palette, ...overrides });
}

// ---------------------------------------------------------------------------
// Brief analysis
// ---------------------------------------------------------------------------

const INDUSTRY_SIGNALS: Array<[SiteIndustry, RegExp, number]> = [
  ["dashboard", /\b(dashboard|admin panel|analytics (?:app|panel|ui)|control panel|crm|back.?office|data table|kanban|management system|ড্যাশবোর্ড)\b/i, 5],
  ["saas", /\b(saas|software as a service|startup|product landing|b2b|platform|api product|subscription (?:app|software)|ai tool|productivity app|waitlist)\b/i, 4],
  ["education", /\b(school|college|university|academy|coaching|madrasa|madrasah|kindergarten|tuition|institute|course(?:s)? (?:site|website|platform)|e-?learning|student|স্কুল|কলেজ|বিদ্যালয়|মাদ্রাসা|শিক্ষা)\b/i, 4],
  ["ecommerce", /\b(e-?commerce|online (?:store|shop)|store|shop|boutique|marketplace|product catalog|cart|checkout|fashion brand|clothing|sneaker|jewel(?:le)?ry|দোকান|শপ)\b/i, 4],
  ["portfolio", /\b(portfolio|personal (?:site|website|brand)|resume|cv|freelancer|photographer|designer(?:'s)? site|showcase my|about me|পোর্টফোলিও)\b/i, 4],
  ["developer", /\b(developer|programmer|software engineer|open.?source|dev(?:eloper)? portfolio|github|engineer(?:ing)? blog|documentation|docs site|cli tool)\b/i, 3],
  ["healthcare", /\b(hospital|clinic|doctor|dental|dentist|medical|health ?care|pharmacy|diagnostic|therapy|therapist|physio|wellness clinic|হাসপাতাল|ক্লিনিক|ডাক্তার)\b/i, 5],
  ["restaurant", /\b(restaurant|cafe|café|coffee shop|bakery|bistro|bar|pizzeria|food truck|catering|menu|biryani|kitchen|রেস্টুরেন্ট|রেস্তোরাঁ|ক্যাফে)\b/i, 4],
  ["news", /\b(news|newspaper|magazine|journal|editorial|press|publication|headline|সংবাদ|পত্রিকা|খবর)\b/i, 4],
  ["agency", /\b(agency|studio|creative (?:agency|studio)|marketing (?:agency|firm)|branding|digital agency|production house|consultancy)\b/i, 4],
  ["corporate", /\b(corporate|company (?:site|website|profile)|enterprise|business website|industrial|manufactur\w+|logistics|group of companies|holding|consult(?:ing|ants)|firm|কোম্পানি)\b/i, 3],
  ["realestate", /\b(real estate|property|properties|realtor|apartment|housing|architecture firm|interior design|construction)\b/i, 4],
  ["fitness", /\b(gym|fitness|yoga|personal trainer|crossfit|sports club|martial arts|workout)\b/i, 4],
  ["travel", /\b(travel|tour(?:ism|s)?|hotel|resort|booking|airline|destination|hostel|adventure)\b/i, 4],
  ["finance", /\b(bank|fintech|finance|insurance|invest(?:ment|ing)?|accounting|crypto|wallet|trading|loan|payment(?:s)? (?:app|platform))\b/i, 4],
  ["nonprofit", /\b(non-?profit|ngo|charity|foundation|donat(?:e|ion)|volunteer|community organi[sz]ation|mosque|church|temple)\b/i, 4],
  ["event", /\b(event|conference|wedding|festival|meetup|summit|concert|hackathon|invitation)\b/i, 4],
  ["blog", /\b(blog|newsletter|writing|essays|diary|ব্লগ)\b/i, 3],
  ["legal", /\b(law firm|lawyer|attorney|legal|advocate|notary|chamber)\b/i, 5],
  ["beauty", /\b(salon|spa|beauty|cosmetic|skincare|barber|makeup|nail studio|parlou?r)\b/i, 4],
  ["game", /\b(game|gaming|esports|arcade|guild|clan)\b/i, 3],
];

const NAMED_COLORS: Record<string, string> = {
  red: "#dc2626", crimson: "#b91c3c", maroon: "#7f1d2d", burgundy: "#6d1a36", rose: "#e11d48", pink: "#ec4899",
  coral: "#f4694b", orange: "#ea6a12", amber: "#d98a06", gold: "#c99a2e", yellow: "#e2b008", mustard: "#c8a02c",
  lime: "#65a30d", green: "#16a34a", emerald: "#059669", forest: "#1f5132", olive: "#6b7031", sage: "#7d9471", mint: "#34c79a",
  teal: "#0f9488", turquoise: "#14b8a6", cyan: "#0891b2", aqua: "#06b6d4", sky: "#0ea5e9", blue: "#2563eb",
  navy: "#16264d", indigo: "#4f46e5", violet: "#7c3aed", purple: "#8b3fd6", lavender: "#9b86e3", magenta: "#c026d3", plum: "#6b2c68",
  brown: "#7a4a2a", chocolate: "#4e2f1c", terracotta: "#c0613f", beige: "#e9dcc6", cream: "#f6efe0", sand: "#d9c5a0", ivory: "#faf6ea",
  white: "#ffffff", black: "#0b0b0c", charcoal: "#22252a", slate: "#475569", gray: "#6b7280", grey: "#6b7280", silver: "#b8bec9",
  লাল: "#dc2626", সবুজ: "#16a34a", নীল: "#2563eb", হলুদ: "#e2b008", কালো: "#0b0b0c", সাদা: "#ffffff", গোলাপি: "#ec4899", বেগুনি: "#7c3aed", কমলা: "#ea6a12",
};

const NEUTRAL_NAMES = new Set(["white", "black", "charcoal", "slate", "gray", "grey", "silver", "beige", "cream", "sand", "ivory", "কালো", "সাদা"]);

const MOOD_SIGNALS: Array<[string, RegExp]> = [
  ["minimal", /\b(minimal(?:ist|istic)?|clean|simple|uncluttered|whitespace|মিনিমাল)\b/i],
  ["premium", /\b(premium|luxur(?:y|ious)|high.?end|elegant|sophisticated|refined|exclusive|প্রিমিয়াম)\b/i],
  ["playful", /\b(playful|fun|friendly|colou?rful|cheerful|kids?|children|vibrant|quirky)\b/i],
  ["bold", /\b(bold|loud|striking|dramatic|brutalis[tm]|high.?contrast|edgy|statement)\b/i],
  ["editorial", /\b(editorial|magazine.?(?:like|style)|serif|typograph(?:y|ic)|storytelling)\b/i],
  ["tech", /\b(futuristic|cyber|neon|techy|hacker|terminal|sci-?fi|glow(?:ing)?)\b/i],
  ["warm", /\b(warm|cozy|cosy|earthy|organic|natural|rustic|handmade)\b/i],
  ["corporate", /\b(professional|trustworthy|formal|serious|corporate|reliable|পেশাদার)\b/i],
  ["glass", /\b(glass(?:morphism|y)?|frosted|translucent|blur(?:red)?)\b/i],
  ["retro", /\b(retro|vintage|80s|90s|y2k|nostalgi\w+|old.?school)\b/i],
  ["modern", /\b(modern|contemporary|sleek|fresh|আধুনিক)\b/i],
];

const KNOWN_FONTS = [
  "Inter", "Manrope", "Poppins", "Montserrat", "Roboto", "Open Sans", "Lato", "Nunito", "DM Sans", "DM Serif Display",
  "Playfair Display", "Merriweather", "Lora", "Fraunces", "Space Grotesk", "Sora", "Outfit", "Plus Jakarta Sans",
  "Work Sans", "Raleway", "Oswald", "Bebas Neue", "Syne", "Libre Baskerville", "Cormorant Garamond", "IBM Plex Sans",
  "IBM Plex Mono", "JetBrains Mono", "Space Mono", "Archivo", "Figtree", "Urbanist", "Rubik", "Karla", "Newsreader",
  "Source Serif 4", "Hind Siliguri", "Noto Sans Bengali", "Noto Serif Bengali", "Baloo Da 2", "Tiro Bangla", "Anek Bangla",
];

const PAGE_SIGNALS: Array<[string, RegExp]> = [
  ["Home", /\b(home ?page|landing)\b/i],
  ["About", /\babout(?: us)?\b/i],
  ["Services", /\bservices?\b/i],
  ["Products", /\b(products?|catalog(?:ue)?|collection)\b/i],
  ["Pricing", /\b(pricing|plans?)\b/i],
  ["Contact", /\bcontact\b/i],
  ["Blog", /\b(blog|articles?|news)\b/i],
  ["Gallery", /\bgaller(?:y|ies)\b/i],
  ["Menu", /\bmenu\b/i],
  ["Admissions", /\badmissions?\b/i],
  ["Projects", /\b(projects?|case stud(?:y|ies)|work)\b/i],
  ["Team", /\b(team|faculty|staff|doctors)\b/i],
  ["FAQ", /\bfaqs?\b/i],
  ["Testimonials", /\b(testimonials?|reviews?)\b/i],
  ["Cart", /\b(cart|checkout)\b/i],
  ["Login", /\b(log ?in|sign ?in|sign ?up|register)\b/i],
];

const FEATURE_SIGNALS: Array<[string, RegExp]> = [
  ["contact form with validation", /\b(contact form|enquiry form|inquiry form|message form)\b/i],
  ["search", /\bsearch\b/i],
  ["product filtering and sorting", /\b(filter|sort)\w*\b/i],
  ["shopping cart", /\b(cart|basket|add to cart)\b/i],
  ["dark/light theme toggle", /\b(theme toggle|dark mode toggle|light and dark|dark\/light)\b/i],
  ["booking / appointment form", /\b(booking|appointment|reservation|reserve a table)\b/i],
  ["newsletter signup", /\b(newsletter|subscribe)\b/i],
  ["image gallery / lightbox", /\b(gallery|lightbox)\b/i],
  ["pricing table", /\bpricing\b/i],
  ["FAQ accordion", /\b(faq|accordion)\b/i],
  ["testimonials", /\b(testimonials?|reviews?)\b/i],
  ["charts / data visualisation", /\b(charts?|graphs?|analytics|statistics|stats)\b/i],
  ["multi-language (Bangla + English)", /\b(bangla and english|bilingual|multi-?language|বাংলা)\b/i],
  ["map / location block", /\b(map|location|directions)\b/i],
];

/** Understand what the user asked for. Everything returned is evidence from the text. */
export function analyzeBrief(prompt: string): BriefAnalysis {
  const text = String(prompt ?? "").slice(0, 6000);
  const constraints: string[] = [];

  // Industry
  let industry: SiteIndustry = "general";
  let best = 0;
  for (const [id, re, weight] of INDUSTRY_SIGNALS) {
    const matches = text.match(new RegExp(re.source, "gi"))?.length ?? 0;
    const score = matches ? weight + Math.min(3, matches - 1) : 0;
    if (score > best) { best = score; industry = id; }
  }
  // "developer portfolio" is a portfolio in a developer voice.
  if (industry === "portfolio" && /\b(developer|programmer|engineer|coder)\b/i.test(text)) industry = "developer";

  // Colours
  const colors: BriefAnalysis["colors"] = [];
  const ROLE_WORDS: Array<[BriefAnalysis["colors"][number]["role"], RegExp]> = [
    ["background", /\b(background|bg|backdrop)\b/],
    ["accent", /\b(accents?|highlights?|secondary|cta|buttons?)\b/],
    ["text", /\b(text|font colou?r)\b/],
    ["primary", /\b(primary|main|brand|theme)\b/],
  ];
  // The role word closest to the colour wins ("#112233 background and orange
  // accent" → background, accent), preferring the word that follows it.
  const roleNear = (index: number, length: number): BriefAnalysis["colors"][number]["role"] => {
    const after = text.slice(index + length, index + length + 28).toLowerCase();
    const before = text.slice(Math.max(0, index - 28), index).toLowerCase();
    let best: { role: BriefAnalysis["colors"][number]["role"]; distance: number } = { role: "any", distance: Infinity };
    for (const [role, re] of ROLE_WORDS) {
      const a = re.exec(after);
      if (a && a.index < best.distance) best = { role, distance: a.index };
      let last: RegExpExecArray | null = null;
      const global = new RegExp(re.source, "g");
      for (let m = global.exec(before); m; m = global.exec(before)) last = m;
      if (last) {
        const distance = before.length - (last.index + last[0].length) + 4;
        if (distance < best.distance) best = { role, distance };
      }
    }
    return best.role;
  };
  for (const m of text.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = normalizeHex(m[0]);
    if (hex) colors.push({ hex, role: roleNear(m.index ?? 0, m[0].length), name: hex });
  }
  const colourNames = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length);
  const colourRe = new RegExp(`(?<![\\p{L}])(${colourNames.join("|")})(?![\\p{L}])`, "giu");
  for (const m of text.matchAll(colourRe)) {
    const name = m[1].toLowerCase();
    // "white space", "black friday", "green energy company" are not colour requests
    // unless a colour context word is nearby.
    const window = text.slice(Math.max(0, (m.index ?? 0) - 45), (m.index ?? 0) + name.length + 45).toLowerCase();
    if (!/(colou?r|palette|theme|background|bg|accent|tone|shade|scheme|gradient|\band\b|,|রঙ|রং|থিম)/.test(window)) continue;
    if (colors.some((c) => c.name === name)) continue;
    colors.push({ hex: NAMED_COLORS[name], role: NEUTRAL_NAMES.has(name) && roleNear(m.index ?? 0, name.length) === "any" ? "background" : roleNear(m.index ?? 0, name.length), name });
  }
  if (colors.length) constraints.push(`Use the requested colours: ${colors.map((c) => `${c.name}${c.role !== "any" ? ` (${c.role})` : ""}`).join(", ")}.`);

  // Mode
  let mode: BriefAnalysis["mode"] = null;
  if (/\b(dark\s+(?:[\w-]+\s+){0,2}(?:mode|theme|ui|design|background|website|site|page|look|dashboard|portfolio|app)|dark-?themed|black background|night mode)\b|ডার্ক/i.test(text)) mode = "dark";
  else if (/\b(light (?:mode|theme|ui|design|background)|white background|bright (?:and|,)? ?(?:clean|airy)|লাইট)\b/i.test(text)) mode = "light";
  if (mode) constraints.push(`Use a ${mode} theme.`);

  // Fonts
  const fonts = KNOWN_FONTS.filter((font) => new RegExp(`\\b${font.replace(/ /g, "\\s+")}\\b`, "i").test(text));
  if (/\bserif\b/i.test(text) && !/sans.?serif/i.test(text) && !fonts.length) constraints.push("Use a serif typeface for headings.");
  if (/\b(mono(?:space)?|typewriter|terminal) (?:font|type|look)\b/i.test(text)) constraints.push("Use a monospace typeface as a visible design element.");
  if (fonts.length) constraints.push(`Use the requested font${fonts.length > 1 ? "s" : ""}: ${fonts.join(", ")}.`);

  const moods = MOOD_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (moods.length) constraints.push(`Requested mood: ${moods.join(", ")}.`);

  const pages = PAGE_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const multiPage = /\b(multi-?page|multiple pages|separate pages?|(\d+|two|three|four|five|six)\s+pages?)\b/i.test(text);
  if (multiPage) constraints.push("Build real separate pages (one HTML file per page) with working links between them.");
  const features = FEATURE_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name);

  // References ("like Stripe", "similar to apple.com", "inspired by Linear")
  const references: string[] = [];
  for (const m of text.matchAll(/\b(?:like|similar to|inspired by|in the style of|same as|reference[:\s]+)\s+((?:https?:\/\/)?[A-Za-z0-9][\w.-]{1,40}(?:\.[a-z]{2,6})?(?:\s+[A-Z][\w-]+)?)/g)) {
    const ref = m[1].trim().replace(/[.,;:!?]+$/, "");
    if (ref.length >= 3 && !/^(a|an|the|this|that|it|modern|premium|professional|clean|real|other)$/i.test(ref.split(/\s+/)[0])) references.push(ref);
  }
  for (const m of text.matchAll(/https?:\/\/[^\s)"'<>]+/g)) if (!references.includes(m[0])) references.push(m[0].slice(0, 120));
  if (references.length) constraints.push(`Take visual cues from: ${references.slice(0, 4).join(", ")} (structure, spacing and tone — never copy content or logos).`);

  // Brand / name
  const brandMatch = /\b(?:called|named|for|brand(?:ed)? as|name(?:d)? is)\s+["“']?([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,3})["”']?/.exec(text)
    ?? /["“]([^"”]{2,40})["”]/.exec(text);
  const brand = brandMatch ? brandMatch[1].trim().replace(/[.,;:]+$/, "") : "";

  // Audience
  const audienceMatch = /\b(?:for|target(?:ing|ed at)?|aimed at|audience(?: is|:)?)\s+((?:young |small |local |busy |new |senior |professional )?(?:students?|parents?|teachers?|developers?|designers?|founders?|startups?|businesses|small businesses|teams?|customers?|shoppers?|patients?|families|kids|children|teenagers?|professionals?|investors?|travell?ers?|recruiters?|clients?|gamers?|readers?|donors?|women|men|enterprises?|freelancers?|creators?|athletes?|couples?)(?:\s+(?:and|&)\s+\w+)?)/i.exec(text);
  const audience = audienceMatch ? audienceMatch[1].trim() : "";

  const firstSentence = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?।])\s/)[0]?.slice(0, 220) ?? "";
  return {
    industry, industryConfidence: best, purpose: firstSentence, audience, brand,
    colors, mode, fonts, moods, pages, features, references: references.slice(0, 6), constraints,
  };
}

// ---------------------------------------------------------------------------
// Design axes — independent building blocks, not page templates
// ---------------------------------------------------------------------------

type Direction = {
  name: string;
  summary: string;
  moods: string[];
  modes: Array<"light" | "dark">;
  /** Base hue ranges [from, to] this direction looks right in. */
  hues: Array<[number, number]>;
  recipes: PaletteRecipe[];
  type: string[];
  heroes: string[];
  navs: string[];
  radius: SiteDesignSpec["layout"]["radius"][];
  density: SiteDesignSpec["layout"]["density"][];
  surfaces: string[];
  motion: string[];
};

type TypePairing = Omit<SiteTypography, "googleFonts"> & { id: string; fonts: string[] };

const TYPE: Record<string, TypePairing> = {
  "geometric-sans": { id: "geometric-sans", heading: "'Sora', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif", fonts: ["Sora:wght@500;600;700", "Inter:wght@400;500;600"], scale: "balanced", headingWeight: 600, headingTracking: "tight", headingCase: "normal" },
  "grotesk-tech": { id: "grotesk-tech", heading: "'Space Grotesk', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif", fonts: ["Space Grotesk:wght@500;600;700", "Inter:wght@400;500;600"], scale: "balanced", headingWeight: 600, headingTracking: "tight", headingCase: "normal" },
  "humanist-friendly": { id: "humanist-friendly", heading: "'Nunito', system-ui, sans-serif", body: "'Nunito', system-ui, sans-serif", fonts: ["Nunito:wght@400;600;700;800"], scale: "balanced", headingWeight: 800, headingTracking: "normal", headingCase: "normal" },
  "editorial-serif": { id: "editorial-serif", heading: "'Fraunces', Georgia, serif", body: "'Inter', system-ui, sans-serif", fonts: ["Fraunces:opsz,wght@9..144,400;9..144,600", "Inter:wght@400;500;600"], scale: "dramatic", headingWeight: 600, headingTracking: "tight", headingCase: "normal" },
  "classic-serif": { id: "classic-serif", heading: "'Playfair Display', Georgia, serif", body: "'Lato', system-ui, sans-serif", fonts: ["Playfair Display:wght@500;700", "Lato:wght@400;700"], scale: "dramatic", headingWeight: 700, headingTracking: "normal", headingCase: "normal" },
  "news-serif": { id: "news-serif", heading: "'Newsreader', Georgia, serif", body: "'Source Serif 4', Georgia, serif", fonts: ["Newsreader:opsz,wght@6..72,500;6..72,700", "Source Serif 4:opsz,wght@8..60,400;8..60,600"], scale: "balanced", headingWeight: 700, headingTracking: "normal", headingCase: "normal" },
  "luxury-serif": { id: "luxury-serif", heading: "'Cormorant Garamond', Georgia, serif", body: "'Manrope', system-ui, sans-serif", fonts: ["Cormorant Garamond:wght@500;600;700", "Manrope:wght@400;500;600"], scale: "dramatic", headingWeight: 600, headingTracking: "normal", headingCase: "normal" },
  "corporate-sans": { id: "corporate-sans", heading: "'Manrope', system-ui, sans-serif", body: "'Manrope', system-ui, sans-serif", fonts: ["Manrope:wght@400;500;600;700;800"], scale: "balanced", headingWeight: 700, headingTracking: "tight", headingCase: "normal" },
  "plex-institutional": { id: "plex-institutional", heading: "'IBM Plex Sans', system-ui, sans-serif", body: "'IBM Plex Sans', system-ui, sans-serif", fonts: ["IBM Plex Sans:wght@400;500;600;700"], scale: "compact", headingWeight: 600, headingTracking: "normal", headingCase: "normal" },
  "condensed-impact": { id: "condensed-impact", heading: "'Oswald', 'Arial Narrow', sans-serif", body: "'Work Sans', system-ui, sans-serif", fonts: ["Oswald:wght@500;600;700", "Work Sans:wght@400;500;600"], scale: "dramatic", headingWeight: 700, headingTracking: "wide", headingCase: "uppercase" },
  "display-poster": { id: "display-poster", heading: "'Syne', system-ui, sans-serif", body: "'DM Sans', system-ui, sans-serif", fonts: ["Syne:wght@600;700;800", "DM Sans:wght@400;500;700"], scale: "dramatic", headingWeight: 800, headingTracking: "tight", headingCase: "normal" },
  "mono-dev": { id: "mono-dev", heading: "'JetBrains Mono', ui-monospace, monospace", body: "'Inter', system-ui, sans-serif", fonts: ["JetBrains Mono:wght@400;600;700", "Inter:wght@400;500;600"], scale: "compact", headingWeight: 700, headingTracking: "tight", headingCase: "normal" },
  "soft-rounded": { id: "soft-rounded", heading: "'Outfit', system-ui, sans-serif", body: "'DM Sans', system-ui, sans-serif", fonts: ["Outfit:wght@500;600;700", "DM Sans:wght@400;500;700"], scale: "balanced", headingWeight: 600, headingTracking: "normal", headingCase: "normal" },
  "jakarta-product": { id: "jakarta-product", heading: "'Plus Jakarta Sans', system-ui, sans-serif", body: "'Plus Jakarta Sans', system-ui, sans-serif", fonts: ["Plus Jakarta Sans:wght@400;500;600;700;800"], scale: "balanced", headingWeight: 700, headingTracking: "tight", headingCase: "normal" },
  "system-dense": { id: "system-dense", heading: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", body: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", fonts: [], scale: "compact", headingWeight: 600, headingTracking: "normal", headingCase: "normal" },
  "bangla-friendly": { id: "bangla-friendly", heading: "'Hind Siliguri', 'Noto Sans Bengali', system-ui, sans-serif", body: "'Hind Siliguri', 'Noto Sans Bengali', system-ui, sans-serif", fonts: ["Hind Siliguri:wght@400;500;600;700"], scale: "balanced", headingWeight: 700, headingTracking: "normal", headingCase: "normal" },
};

const HERO: Record<string, string> = {
  "split-product": "Two-column hero: concise value proposition and primary/secondary CTA on one side, a real product UI mock (built in HTML/CSS, not an image placeholder) on the other; stacks copy-first on mobile.",
  "centered-statement": "Centred statement hero: one strong headline (max ~10 words), a single supporting sentence, one primary CTA, and a quiet proof row (logos, numbers or rating) beneath.",
  "editorial-left": "Editorial hero: oversized left-aligned headline on a 12-column grid with a narrow intro column and generous negative space; no card behind the text.",
  "full-bleed-image": "Full-bleed photographic hero with a readable scrim, headline set low-left, and a compact action bar; image uses object-cover and a fixed aspect ratio so it never distorts.",
  "product-first": "Product-first hero: a featured product or collection with price and an immediate shop action, flanked by two smaller promotional tiles — shopping starts above the fold.",
  "bento": "Bento hero: headline cell plus 3–5 asymmetric cells showing real features, stats or media; collapses to a single column in reading order on mobile.",
  "search-led": "Task-led hero: a short headline with the primary task embedded directly (search, booking, appointment or enquiry form) so users can act without scrolling.",
  "type-only": "Typographic hero: no imagery — scale, weight and one accent colour carry the composition; a thin rule or index number grounds it.",
  "masthead": "Masthead layout: publication title and date strip, then a lead story with large image and headline beside a ranked column of secondary stories.",
  "intro-card": "Personal intro: portrait or monogram, name, one-line positioning and direct links (work, contact, résumé), immediately followed by selected work.",
  "terminal": "Developer intro: a compact, real-looking terminal/code block that introduces the person or tool, beside a plain-language headline; code is selectable text, not an image.",
  "stat-led": "Evidence-led hero: headline beside three or four large, real figures (years, clients, outcomes) presented as a designed numeric strip.",
  "app-shell": "No marketing hero: the page opens directly in the application shell — sidebar or top navigation, page title with actions, KPI row, then the primary data view.",
  "menu-led": "Atmospheric hero with the venue name, cuisine line, opening hours and two actions (view menu, reserve), leading straight into signature dishes.",
  "layered-collage": "Layered collage hero: overlapping media frames, a rotated label or badge, and a headline that crosses the frames — composed, not random.",
  "timeline-led": "Date-led hero: event name, date, place and countdown or registration action, with a schedule preview directly beneath.",
};

const NAV: Record<string, { style: string; mobile: string }> = {
  "top-bar": { style: "Horizontal top bar: brand left, 4–6 text links, one emphasised action right; becomes sticky with a hairline border after scrolling.", mobile: "Hamburger button opens a full-height slide-in panel with large tap targets, a close button, focus trap and Escape to close." },
  "centered-logo": { style: "Centred brand mark with links split left and right, generous height, thin divider below.", mobile: "Brand centred, menu button left; menu opens as a full-screen overlay with stacked links." },
  "floating-pill": { style: "Floating pill navigation detached from the top edge with backdrop blur and a soft shadow; links centred, action at the end.", mobile: "Pill shrinks to brand + menu button; menu drops as a rounded sheet beneath the pill." },
  "sidebar": { style: "Persistent left sidebar with grouped sections, icons + labels and a clear active state; content scrolls independently.", mobile: "Sidebar becomes an off-canvas drawer toggled from a top bar; a bottom tab bar exposes the 4 primary destinations." },
  "minimal-overlay": { style: "Minimal header: brand and a single “Menu” control; navigation opens as a full-screen typographic overlay with numbered links.", mobile: "Same full-screen overlay, links sized for thumbs, contact details at the bottom." },
  "mega": { style: "Top bar with a utility strip above (phone, hours, language) and dropdown panels for grouped destinations.", mobile: "Accordion navigation inside a slide-in panel; utility information moves to the panel footer." },
  "commerce": { style: "Commerce header: brand, category links, a prominent search field, and account / wishlist / cart icons with a live cart count.", mobile: "Search collapses to an icon; categories in a slide-in drawer; cart stays visible in the header." },
  "editorial-strip": { style: "Publication header: date and edition strip, large wordmark, then a horizontally scrollable section bar.", mobile: "Wordmark with menu and search icons; sections scroll horizontally with visible overflow affordance." },
  "tabbed": { style: "Compact top bar with segmented tabs for the main views and a command/search trigger.", mobile: "Tabs become a bottom navigation bar with icons and labels; secondary items in a “More” sheet." },
  "side-rail": { style: "Slim vertical rail on the left with the brand rotated or stacked and anchor links to sections; content sits in a wide column.", mobile: "Rail collapses into a top bar with an anchored section menu." },
};

const D = (d: Direction) => d;
const DIRECTIONS: Record<string, Direction> = {
  "product-precision": D({ name: "Product precision", summary: "Crisp, product-led and confident: real interface previews, tight grid, restrained colour with one decisive accent.", moods: ["modern", "minimal", "tech"], modes: ["light", "dark"], hues: [[205, 265], [150, 175], [15, 30]], recipes: [{ ground: "white", harmony: "analogous", saturation: "vivid" }, { ground: "deep", harmony: "split", saturation: "vivid" }, { ground: "tinted", harmony: "mono", saturation: "balanced" }], type: ["geometric-sans", "grotesk-tech", "jakarta-product"], heroes: ["split-product", "bento", "centered-statement"], navs: ["top-bar", "floating-pill"], radius: ["md", "lg", "xl"], density: ["balanced"], surfaces: ["Hairline borders and subtle elevation; one tinted band to separate proof from features.", "Soft layered cards on a faintly tinted canvas; no heavy shadows."], motion: ["Short fade-and-rise on scroll (≤ 250 ms), hover lift on cards, animated number counters once."] }),
  "dark-developer": D({ name: "Developer dark", summary: "Dark, technical and exact: monospace details, code as a first-class visual, luminous accent on near-black.", moods: ["tech", "bold", "modern"], modes: ["dark"], hues: [[140, 170], [185, 205], [265, 290], [25, 45]], recipes: [{ ground: "charcoal", harmony: "mono", saturation: "vivid" }, { ground: "ink", harmony: "split", saturation: "vivid" }], type: ["mono-dev", "grotesk-tech"], heroes: ["terminal", "type-only", "bento"], navs: ["top-bar", "side-rail", "tabbed"], radius: ["sm", "md"], density: ["balanced", "dense"], surfaces: ["Flat panels with 1px borders, grid-line background at very low opacity.", "Solid dark panels, accent used only for interactive states and key figures."], motion: ["Caret blink and typed-line reveal in the intro only; everything else instant with clear focus rings."] }),
  "warm-editorial": D({ name: "Warm editorial", summary: "Magazine-like and human: serif display type, paper tones, asymmetric columns and generous white space.", moods: ["editorial", "warm", "premium"], modes: ["light"], hues: [[12, 40], [340, 360], [80, 110]], recipes: [{ ground: "paper", harmony: "analogous", saturation: "muted" }, { ground: "paper", harmony: "complementary", saturation: "balanced" }], type: ["editorial-serif", "classic-serif", "luxury-serif"], heroes: ["editorial-left", "type-only", "layered-collage"], navs: ["minimal-overlay", "centered-logo", "side-rail"], radius: ["none", "sm"], density: ["airy"], surfaces: ["No cards — content separated by rules, whitespace and scale.", "Paper background with fine rules and occasional full-bleed image bands."], motion: ["Slow image reveal and underline-draw link hovers; no bouncing."] }),
  "institutional-trust": D({ name: "Institutional trust", summary: "Clear, credible and organised: strong information hierarchy, notices and key actions visible at once.", moods: ["corporate", "modern"], modes: ["light"], hues: [[200, 235], [150, 170], [350, 10], [28, 42]], recipes: [{ ground: "white", harmony: "split", saturation: "balanced" }, { ground: "tinted", harmony: "analogous", saturation: "balanced" }, { ground: "white", harmony: "complementary", saturation: "muted" }], type: ["corporate-sans", "plex-institutional", "soft-rounded"], heroes: ["search-led", "stat-led", "full-bleed-image"], navs: ["mega", "top-bar"], radius: ["sm", "md"], density: ["balanced"], surfaces: ["Structured sections with tinted bands and bordered information cards.", "White canvas, coloured header band, list-style notices with dates."], motion: ["Subtle hover and focus states only; nothing that delays reading."] }),
  "friendly-campus": D({ name: "Friendly campus", summary: "Welcoming and optimistic: rounded shapes, cheerful secondary colour, people-first photography.", moods: ["playful", "warm"], modes: ["light"], hues: [[195, 215], [25, 45], [140, 160], [270, 290]], recipes: [{ ground: "tinted", harmony: "triadic", saturation: "vivid" }, { ground: "white", harmony: "complementary", saturation: "balanced" }], type: ["humanist-friendly", "soft-rounded"], heroes: ["full-bleed-image", "split-product", "layered-collage"], navs: ["top-bar", "floating-pill"], radius: ["lg", "xl"], density: ["balanced", "airy"], surfaces: ["Soft rounded cards, shaped section dividers (curve or wave used once).", "Colour-blocked sections with rounded image frames."], motion: ["Gentle hover scale on cards and buttons; one playful accent animation at most."] }),
  "shop-window": D({ name: "Shop window", summary: "Product-first and fast: big imagery, clear prices, obvious actions and almost no decorative chrome.", moods: ["modern", "minimal"], modes: ["light"], hues: [[0, 360]], recipes: [{ ground: "white", harmony: "mono", saturation: "balanced" }, { ground: "paper", harmony: "complementary", saturation: "balanced" }], type: ["corporate-sans", "soft-rounded", "jakarta-product"], heroes: ["product-first", "full-bleed-image"], navs: ["commerce"], radius: ["none", "sm", "md"], density: ["balanced", "dense"], surfaces: ["Borderless product tiles on white; price and name set tight under square-ratio media.", "Thin-bordered tiles with quick-add on hover/focus; sale badges in the accent colour."], motion: ["Image cross-fade on product hover, cart count pulse on add; otherwise instant."] }),
  "boutique-luxe": D({ name: "Boutique luxe", summary: "Quiet luxury: lots of air, refined serif headlines, muted palette and slow, deliberate pacing.", moods: ["premium", "minimal", "editorial"], modes: ["light", "dark"], hues: [[30, 48], [340, 355], [150, 170], [210, 230]], recipes: [{ ground: "paper", harmony: "mono", saturation: "muted" }, { ground: "charcoal", harmony: "mono", saturation: "muted" }], type: ["luxury-serif", "classic-serif", "editorial-serif"], heroes: ["full-bleed-image", "editorial-left", "type-only"], navs: ["centered-logo", "minimal-overlay"], radius: ["none"], density: ["airy"], surfaces: ["No shadows, no rounded corners; thin rules, large margins, small uppercase labels.", "Full-bleed imagery alternating with narrow text columns."], motion: ["Slow fades (400–600 ms) and parallax-free image reveals."] }),
  "bold-studio": D({ name: "Bold studio", summary: "Distinctive and opinionated: oversized type, hard colour blocks, unexpected grid breaks.", moods: ["bold", "playful", "retro"], modes: ["light", "dark"], hues: [[0, 360]], recipes: [{ ground: "white", harmony: "complementary", saturation: "vivid" }, { ground: "ink", harmony: "triadic", saturation: "vivid" }, { ground: "paper", harmony: "split", saturation: "vivid" }], type: ["display-poster", "condensed-impact", "grotesk-tech"], heroes: ["type-only", "layered-collage", "bento"], navs: ["minimal-overlay", "side-rail", "floating-pill"], radius: ["none", "full"], density: ["airy", "balanced"], surfaces: ["Solid colour blocks with thick borders; no gradients.", "High-contrast panels and a visible grid; marquee or ticker used once."], motion: ["Marquee strip, hover colour inversions and snappy 120 ms transitions."] }),
  "calm-care": D({ name: "Calm care", summary: "Reassuring and accessible: soft colour, large readable type, plain language and obvious next steps.", moods: ["corporate", "warm", "minimal"], modes: ["light"], hues: [[165, 200], [200, 220], [140, 160]], recipes: [{ ground: "tinted", harmony: "analogous", saturation: "muted" }, { ground: "white", harmony: "analogous", saturation: "balanced" }], type: ["soft-rounded", "humanist-friendly", "corporate-sans"], heroes: ["search-led", "split-product", "stat-led"], navs: ["mega", "top-bar"], radius: ["md", "lg"], density: ["airy", "balanced"], surfaces: ["Soft tinted panels, large touch targets, iconography with text labels.", "White cards on a pale tinted canvas with clear section headings."], motion: ["Minimal — only state changes; respects reduced-motion fully."] }),
  "data-dense": D({ name: "Data dense", summary: "Functional and information-rich: compact rhythm, strong alignment, colour reserved for status and data.", moods: ["tech", "minimal", "corporate"], modes: ["light", "dark"], hues: [[205, 250], [150, 175], [260, 280]], recipes: [{ ground: "tinted", harmony: "mono", saturation: "balanced" }, { ground: "charcoal", harmony: "mono", saturation: "balanced" }], type: ["system-dense", "plex-institutional", "corporate-sans"], heroes: ["app-shell"], navs: ["sidebar", "tabbed"], radius: ["sm", "md"], density: ["dense"], surfaces: ["Panels with 1px borders, zebra tables, sticky table headers, semantic status colours.", "Card grid for KPIs above a primary table/chart area; filters in a toolbar."], motion: ["None beyond 100 ms state transitions and skeleton loading placeholders."] }),
  "savory-story": D({ name: "Savory story", summary: "Appetising and atmospheric: rich imagery, warm tones, the menu treated as the main content.", moods: ["warm", "premium", "editorial"], modes: ["dark", "light"], hues: [[8, 32], [35, 50], [95, 130]], recipes: [{ ground: "ink", harmony: "analogous", saturation: "balanced" }, { ground: "paper", harmony: "analogous", saturation: "balanced" }], type: ["classic-serif", "editorial-serif", "condensed-impact"], heroes: ["menu-led", "full-bleed-image"], navs: ["centered-logo", "top-bar", "minimal-overlay"], radius: ["none", "sm", "lg"], density: ["airy", "balanced"], surfaces: ["Menu set as elegant two-column lists with dotted leaders and prices right-aligned.", "Dish cards with tall imagery, section tabs for menu categories."], motion: ["Image fade-ins and a smooth category switch for the menu."] }),
  "front-page": D({ name: "Front page", summary: "Editorial hierarchy above all: masthead, lead story, ranked columns, dense but highly legible.", moods: ["editorial", "corporate"], modes: ["light"], hues: [[0, 12], [210, 230], [0, 0]], recipes: [{ ground: "white", harmony: "mono", saturation: "balanced" }, { ground: "paper", harmony: "mono", saturation: "muted" }], type: ["news-serif", "classic-serif"], heroes: ["masthead"], navs: ["editorial-strip"], radius: ["none"], density: ["dense", "balanced"], surfaces: ["Column rules, section labels in small caps, bylines and timestamps on every item.", "Multi-column grid with a ranked “most read” list and a breaking-news strip."], motion: ["None except link hover underlines and a live-updates indicator."] }),
  "corporate-premium": D({ name: "Corporate premium", summary: "Composed and premium: deep neutral base, precise spacing, evidence (figures, clients, credentials) up front.", moods: ["corporate", "premium", "modern"], modes: ["light", "dark"], hues: [[210, 235], [160, 180], [35, 45], [345, 355]], recipes: [{ ground: "white", harmony: "mono", saturation: "muted" }, { ground: "deep", harmony: "complementary", saturation: "muted" }, { ground: "paper", harmony: "mono", saturation: "balanced" }], type: ["corporate-sans", "luxury-serif", "plex-institutional"], heroes: ["stat-led", "editorial-left", "full-bleed-image"], navs: ["top-bar", "mega"], radius: ["none", "sm"], density: ["airy", "balanced"], surfaces: ["Large quiet sections, numbered capabilities, logo wall in monochrome.", "Alternating deep and light bands with thin gold or accent rules."], motion: ["Restrained fades and number count-ups; no decorative animation."] }),
  "personal-canvas": D({ name: "Personal canvas", summary: "Personal and crafted: a distinct voice, selected work shown large, small details that reward attention.", moods: ["editorial", "minimal", "playful"], modes: ["light", "dark"], hues: [[0, 360]], recipes: [{ ground: "paper", harmony: "complementary", saturation: "balanced" }, { ground: "charcoal", harmony: "split", saturation: "vivid" }, { ground: "white", harmony: "mono", saturation: "balanced" }], type: ["editorial-serif", "display-poster", "grotesk-tech", "soft-rounded"], heroes: ["intro-card", "type-only", "editorial-left"], navs: ["side-rail", "minimal-overlay", "floating-pill"], radius: ["none", "md", "xl"], density: ["airy"], surfaces: ["Work presented as large case-study rows with role, year and outcome.", "Masonry or offset grid of projects; captions in small mono text."], motion: ["Cursor-aware hover previews on work items; smooth anchor scrolling."] }),
  "energy-pulse": D({ name: "Energy pulse", summary: "High-energy and motivating: condensed uppercase type, strong diagonals, saturated accent on dark.", moods: ["bold", "tech"], modes: ["dark", "light"], hues: [[0, 20], [45, 65], [140, 160], [190, 205]], recipes: [{ ground: "charcoal", harmony: "mono", saturation: "vivid" }, { ground: "white", harmony: "complementary", saturation: "vivid" }], type: ["condensed-impact", "display-poster"], heroes: ["full-bleed-image", "stat-led", "timeline-led"], navs: ["top-bar", "minimal-overlay"], radius: ["none", "sm"], density: ["balanced"], surfaces: ["Angled section edges, bold numeric labels, schedule/plan tables.", "Full-width image bands with overlaid uppercase labels."], motion: ["Quick slide-ins and a counter/countdown; hover skew on CTAs kept subtle."] }),
  "open-horizon": D({ name: "Open horizon", summary: "Aspirational and visual: wide imagery, soft natural palette, discovery cards and an easy booking path.", moods: ["warm", "modern", "premium"], modes: ["light"], hues: [[185, 205], [20, 40], [150, 170]], recipes: [{ ground: "white", harmony: "complementary", saturation: "balanced" }, { ground: "paper", harmony: "analogous", saturation: "balanced" }], type: ["soft-rounded", "editorial-serif", "jakarta-product"], heroes: ["search-led", "full-bleed-image", "layered-collage"], navs: ["floating-pill", "top-bar"], radius: ["lg", "xl"], density: ["airy", "balanced"], surfaces: ["Large image cards with location, duration and price overlays.", "Horizontal scrolling destination rail with snap points."], motion: ["Image zoom on hover, smooth rail scrolling with visible controls."] }),
  "clear-ledger": D({ name: "Clear ledger", summary: "Secure and precise: sober palette, numeric clarity, calm confidence and visible compliance signals.", moods: ["corporate", "tech", "minimal"], modes: ["light", "dark"], hues: [[150, 172], [215, 240], [255, 270]], recipes: [{ ground: "white", harmony: "mono", saturation: "balanced" }, { ground: "deep", harmony: "analogous", saturation: "balanced" }], type: ["plex-institutional", "geometric-sans", "corporate-sans"], heroes: ["split-product", "stat-led", "centered-statement"], navs: ["top-bar", "mega"], radius: ["sm", "md"], density: ["balanced"], surfaces: ["Tabular figures, comparison tables, security/credential badges row.", "Clean cards with numeric emphasis and a calculator or rate module."], motion: ["Number tickers and chart draw-in once; nothing looping."] }),
  "community-heart": D({ name: "Community heart", summary: "Human and hopeful: real stories, a clear cause, a visible way to help on every screen.", moods: ["warm", "playful", "corporate"], modes: ["light"], hues: [[10, 30], [140, 165], [200, 215], [40, 52]], recipes: [{ ground: "paper", harmony: "complementary", saturation: "balanced" }, { ground: "white", harmony: "triadic", saturation: "balanced" }], type: ["humanist-friendly", "editorial-serif", "soft-rounded"], heroes: ["full-bleed-image", "stat-led", "split-product"], navs: ["top-bar", "centered-logo"], radius: ["md", "lg"], density: ["airy", "balanced"], surfaces: ["Impact figures, story cards with portraits, a persistent donate/join action.", "Hand-drawn-feel dividers used sparingly; warm photographic bands."], motion: ["Progress-bar fill for goals; gentle fades."] }),
  "soft-ritual": D({ name: "Soft ritual", summary: "Soft and sensory: pastel or nude palette, delicate type, rounded media and unhurried spacing.", moods: ["premium", "warm", "minimal"], modes: ["light"], hues: [[335, 355], [18, 35], [270, 290], [150, 165]], recipes: [{ ground: "paper", harmony: "analogous", saturation: "muted" }, { ground: "tinted", harmony: "mono", saturation: "muted" }], type: ["luxury-serif", "soft-rounded", "editorial-serif"], heroes: ["full-bleed-image", "layered-collage", "search-led"], navs: ["centered-logo", "floating-pill"], radius: ["xl", "full", "lg"], density: ["airy"], surfaces: ["Arched or pill-shaped image frames, treatment/price lists with fine dividers.", "Soft tinted cards, generous padding, small uppercase category labels."], motion: ["Slow fades and a soft image scale on hover."] }),
  "arcade-neon": D({ name: "Arcade neon", summary: "Immersive and electric: near-black canvas, saturated neon accents, angular panels and game-UI details.", moods: ["tech", "bold", "retro", "playful"], modes: ["dark"], hues: [[280, 320], [170, 195], [95, 130]], recipes: [{ ground: "ink", harmony: "complementary", saturation: "vivid" }, { ground: "deep", harmony: "triadic", saturation: "vivid" }], type: ["condensed-impact", "display-poster", "mono-dev"], heroes: ["full-bleed-image", "bento", "layered-collage"], navs: ["top-bar", "tabbed"], radius: ["none", "sm"], density: ["balanced"], surfaces: ["Angled/clipped panels with glowing 1px borders, stat bars and badges.", "HUD-style frames and leaderboard tables."], motion: ["Glow pulses on key actions and hover scanline accents — never on body text."] }),
  "quiet-essay": D({ name: "Quiet essay", summary: "Reading-first: one comfortable text column, careful typography, almost no interface.", moods: ["minimal", "editorial"], modes: ["light", "dark"], hues: [[0, 360]], recipes: [{ ground: "paper", harmony: "mono", saturation: "muted" }, { ground: "charcoal", harmony: "mono", saturation: "muted" }], type: ["news-serif", "editorial-serif", "geometric-sans"], heroes: ["type-only", "editorial-left"], navs: ["minimal-overlay", "top-bar"], radius: ["none", "sm"], density: ["airy"], surfaces: ["Single 65–72ch column, post list with dates, pull quotes and footnotes.", "Index-style list of writing grouped by year."], motion: ["None beyond link hover states."] }),
  "blueprint": D({ name: "Blueprint", summary: "Architectural and measured: strict grid, large plan-like imagery, fine lines and specification-style detail.", moods: ["minimal", "premium", "corporate"], modes: ["light", "dark"], hues: [[205, 225], [30, 45], [0, 0]], recipes: [{ ground: "white", harmony: "mono", saturation: "muted" }, { ground: "charcoal", harmony: "mono", saturation: "muted" }], type: ["grotesk-tech", "corporate-sans", "luxury-serif"], heroes: ["full-bleed-image", "search-led", "editorial-left"], navs: ["top-bar", "minimal-overlay", "side-rail"], radius: ["none", "sm"], density: ["airy", "balanced"], surfaces: ["Listing cards with key specs (area, rooms, price) in a small data row.", "Full-bleed project imagery with numbered captions and thin grid lines."], motion: ["Image reveal wipes and smooth filter transitions."] }),
};

const INDUSTRY_DIRECTIONS: Record<SiteIndustry, string[]> = {
  saas: ["product-precision", "dark-developer", "bold-studio", "clear-ledger"],
  education: ["institutional-trust", "friendly-campus", "warm-editorial", "corporate-premium"],
  ecommerce: ["shop-window", "boutique-luxe", "bold-studio", "soft-ritual"],
  portfolio: ["personal-canvas", "warm-editorial", "bold-studio", "quiet-essay"],
  developer: ["dark-developer", "personal-canvas", "product-precision", "quiet-essay"],
  corporate: ["corporate-premium", "institutional-trust", "blueprint", "clear-ledger"],
  healthcare: ["calm-care", "institutional-trust", "corporate-premium"],
  dashboard: ["data-dense"],
  restaurant: ["savory-story", "warm-editorial", "boutique-luxe", "bold-studio"],
  news: ["front-page", "quiet-essay", "warm-editorial"],
  agency: ["bold-studio", "personal-canvas", "warm-editorial", "product-precision"],
  realestate: ["blueprint", "corporate-premium", "open-horizon", "boutique-luxe"],
  fitness: ["energy-pulse", "bold-studio", "product-precision"],
  travel: ["open-horizon", "warm-editorial", "boutique-luxe"],
  finance: ["clear-ledger", "corporate-premium", "product-precision"],
  nonprofit: ["community-heart", "institutional-trust", "warm-editorial"],
  event: ["energy-pulse", "bold-studio", "boutique-luxe", "friendly-campus"],
  blog: ["quiet-essay", "warm-editorial", "front-page", "personal-canvas"],
  legal: ["corporate-premium", "institutional-trust", "warm-editorial"],
  beauty: ["soft-ritual", "boutique-luxe", "warm-editorial"],
  game: ["arcade-neon", "bold-studio", "dark-developer"],
  general: ["product-precision", "warm-editorial", "corporate-premium", "bold-studio", "personal-canvas", "institutional-trust"],
};

const INDUSTRY_COMPONENTS: Record<SiteIndustry, string[]> = {
  saas: ["product preview built in HTML/CSS", "feature groups with real benefit copy", "social proof (logos or metrics)", "pricing tiers with a highlighted plan", "FAQ", "final call to action"],
  education: ["notice / announcements list with dates", "programmes or classes overview", "admissions steps with a clear apply action", "faculty or leadership highlights", "campus life gallery", "contact, map and office hours"],
  ecommerce: ["category navigation", "product grid with price, rating and quick add", "featured collection", "trust row (delivery, returns, payment)", "cart drawer or cart page", "newsletter signup"],
  portfolio: ["selected work with role and outcome", "about with a real point of view", "skills or services", "testimonials or clients", "contact section with direct links"],
  developer: ["project cards with stack, links and outcome", "skills grouped by area", "experience timeline", "open-source or writing list", "contact with email and profile links"],
  corporate: ["capabilities / services overview", "key figures", "industries or clients served", "leadership or team", "case studies or news", "contact with offices"],
  healthcare: ["appointment / contact action above the fold", "services or departments", "doctor profiles with specialties", "patient information (hours, insurance, emergency)", "testimonials", "location and accessibility details"],
  dashboard: ["KPI summary cards", "primary chart area", "filterable, sortable data table", "activity or alerts feed", "empty, loading and error states", "settings or profile menu"],
  restaurant: ["menu grouped by category with prices", "signature dishes", "opening hours and location", "reservation action", "story / chef section", "gallery"],
  news: ["lead story", "section fronts", "latest / most-read list", "article cards with byline and timestamp", "opinion or feature strip", "newsletter signup"],
  agency: ["case studies with results", "services", "process", "team or culture", "client list", "project enquiry form"],
  realestate: ["listing cards with key specs", "search / filter bar", "featured property", "neighbourhood or project highlights", "agent contact", "enquiry form"],
  fitness: ["class schedule", "membership plans", "trainer profiles", "results / testimonials", "trial or join action", "location and hours"],
  travel: ["destination cards", "search or enquiry form", "itinerary highlights", "reviews", "pricing / packages", "contact and FAQs"],
  finance: ["product overview", "rates, fees or calculator", "security and compliance signals", "how it works steps", "testimonials or figures", "FAQ"],
  nonprofit: ["mission statement", "impact figures", "programmes", "stories", "donate / volunteer action", "partners and transparency"],
  event: ["date, place and registration action", "schedule / agenda", "speakers or line-up", "tickets", "venue and travel", "FAQ"],
  blog: ["post list with dates and reading time", "featured post", "topics / tags", "author note", "newsletter signup"],
  legal: ["practice areas", "attorney profiles", "credentials and results", "consultation request", "FAQ", "office details"],
  beauty: ["treatment menu with prices", "booking action", "before/after or gallery", "team", "reviews", "location and hours"],
  game: ["key art and trailer area", "features / modes", "characters or items", "news / patch notes", "community links", "play or download action"],
  general: ["clear statement of what this is", "main content sections that match the request", "supporting proof", "contact or next-step action"],
};

const INDUSTRY_PAGES: Record<SiteIndustry, string[]> = {
  saas: ["Home"], education: ["Home"], ecommerce: ["Home"], portfolio: ["Home"], developer: ["Home"], corporate: ["Home"],
  healthcare: ["Home"], dashboard: ["Dashboard"], restaurant: ["Home"], news: ["Home"], agency: ["Home"], realestate: ["Home"],
  fitness: ["Home"], travel: ["Home"], finance: ["Home"], nonprofit: ["Home"], event: ["Home"], blog: ["Home"], legal: ["Home"],
  beauty: ["Home"], game: ["Home"], general: ["Home"],
};

const INDUSTRY_AUDIENCE: Record<SiteIndustry, string> = {
  saas: "busy professionals evaluating a product", education: "students, parents and prospective applicants", ecommerce: "shoppers comparing products on their phones",
  portfolio: "potential clients and collaborators", developer: "recruiters, engineering leads and fellow developers", corporate: "business decision-makers and partners",
  healthcare: "patients and families who need clear, calm information", dashboard: "operators who use the tool daily", restaurant: "hungry locals and visitors deciding where to eat",
  news: "readers scanning for what matters now", agency: "brands looking for a creative partner", realestate: "buyers and renters comparing properties",
  fitness: "people looking to start or level up training", travel: "travellers planning a trip", finance: "customers who need to trust before they act",
  nonprofit: "supporters, donors and volunteers", event: "prospective attendees", blog: "readers who come for the writing", legal: "clients seeking credible counsel",
  beauty: "clients booking a treatment", game: "players and community members", general: "the people this site is meant to serve",
};

const IMAGERY: Record<SiteIndustry, string> = {
  saas: "Build product visuals as real HTML/CSS interface mocks (panels, charts, tables). No stock-photo heroes.",
  dashboard: "No decorative imagery. Charts are drawn with inline SVG or CSS from the sample data shown.",
  developer: "Code blocks, diagrams and project thumbnails composed in HTML/CSS/SVG.",
  news: "Editorial photography with captions and credits; consistent 3:2 or 16:9 ratios.",
  general: "Purposeful imagery only; consistent aspect ratios.",
  education: "People-first photography (students, classrooms, campus) with consistent ratios and descriptive alt text.",
  ecommerce: "Product photography on consistent square or 4:5 frames with object-cover; every product has an image.",
  portfolio: "Large project visuals with consistent ratios; captions state role and year.",
  corporate: "Confident, real-world photography (people, facilities) or abstract brand shapes in SVG — not clip-art icons.",
  healthcare: "Warm, real-looking photography of care settings; simple line icons with text labels.",
  restaurant: "Appetising food and interior photography; tall and wide crops mixed deliberately.",
  agency: "Case-study visuals presented large; bold crops.",
  realestate: "Wide architectural photography; listing images at a fixed ratio.",
  fitness: "High-contrast action photography with strong crops.",
  travel: "Wide landscape imagery and destination cards with location labels.",
  finance: "Interface mocks, simple charts and abstract shapes; avoid cliché stock imagery.",
  nonprofit: "Authentic portraits and field photography with respectful captions.",
  event: "Venue, speaker and crowd imagery; speaker portraits in a consistent frame.",
  blog: "Sparse imagery; when used, full-column width with captions.",
  legal: "Restrained portrait and office photography; no gavel clichés.",
  beauty: "Soft, well-lit treatment and product imagery in arched or rounded frames.",
  game: "Key art, character and environment imagery with dramatic crops.",
};

function imageryRule(industry: SiteIndustry): string {
  return `${IMAGERY[industry]} When photographs are needed and no generated assets were supplied, use real, topic-specific remote photos (e.g. https://images.unsplash.com/… or https://picsum.photos/seed/<topic-word>/<w>/<h>) with explicit width/height or aspect-ratio, object-cover, loading="lazy" and meaningful alt text. Never use grey placeholder boxes or placeholder services.`;
}

// ---------------------------------------------------------------------------
// Spec generation
// ---------------------------------------------------------------------------

function hueInRanges(rand: () => number, ranges: Array<[number, number]>): number {
  const [from, to] = pick(rand, ranges);
  return Math.round(from + rand() * Math.max(0, to - from));
}

function typographyFrom(pairing: TypePairing): SiteTypography {
  const { id: _id, fonts, ...rest } = pairing;
  void _id;
  return { ...rest, googleFonts: fonts };
}

function fontRequest(fonts: string[], base: SiteTypography): SiteTypography {
  if (!fonts.length) return base;
  const mono = (name: string) => /mono/i.test(name);
  const serif = (name: string) => /serif|playfair|merriweather|lora|fraunces|baskerville|garamond|newsreader|tiro/i.test(name) && !/sans/i.test(name);
  const stack = (name: string) => `'${name}', ${mono(name) ? "ui-monospace, monospace" : serif(name) ? "Georgia, serif" : "system-ui, sans-serif"}`;
  const heading = fonts[0];
  const body = fonts[1] ?? fonts[0];
  return {
    ...base,
    heading: stack(heading),
    body: mono(body) && fonts.length === 1 ? base.body : stack(body),
    googleFonts: [...new Set([heading, body])].map((name) => `${name}:wght@400;500;600;700`),
  };
}

export type CreateSpecOptions = {
  /** Varies free choices between projects. Use the project id (or run id). */
  seed?: string;
  /** Directions to steer away from (e.g. the look being replaced). */
  avoidDirections?: string[];
  /** Hue to steer away from when the user asks for a different palette. */
  avoidHue?: number | null;
  title?: string;
};

/** Create a complete, contrast-safe design specification for a brief. */
export function createDesignSpec(prompt: string, options: CreateSpecOptions = {}): SiteDesignSpec {
  const brief = analyzeBrief(prompt);
  const seed = options.seed ?? `${prompt.length}:${hash32(prompt)}`;
  const rand = seededRandom(`${seed}|${brief.industry}`);

  // --- direction: industry candidates, re-weighted by the moods the user used
  const candidates = INDUSTRY_DIRECTIONS[brief.industry].filter((id) => !(options.avoidDirections ?? []).includes(DIRECTIONS[id].name));
  const pool = candidates.length ? candidates : INDUSTRY_DIRECTIONS[brief.industry];
  const scored = pool.map((id) => {
    const direction = DIRECTIONS[id];
    const moodHits = brief.moods.filter((mood) => direction.moods.includes(mood)).length;
    const modeOk = !brief.mode || direction.modes.includes(brief.mode);
    return { id, score: moodHits * 3 + (modeOk ? 1 : -2) };
  });
  // Moods the industry's usual directions cannot express pull in a direction that can.
  if (brief.moods.length && Math.max(...scored.map((s) => s.score)) < 3) {
    for (const [id, direction] of Object.entries(DIRECTIONS)) {
      if (id === "data-dense" || id === "front-page" || pool.includes(id)) continue;
      const hits = brief.moods.filter((mood) => direction.moods.includes(mood)).length;
      if (hits >= 2) scored.push({ id, score: hits * 3 - 1 });
    }
  }
  const top = Math.max(...scored.map((s) => s.score));
  const finalists = scored.filter((s) => s.score >= top - (brief.moods.length ? 0 : 1)).map((s) => s.id);
  const directionId = pick(rand, finalists);
  const direction = DIRECTIONS[directionId];

  // --- palette
  const mode: "light" | "dark" = brief.mode ?? pick(rand, direction.modes);
  const recipes = direction.recipes.filter((recipe) => (mode === "dark") === ["ink", "deep", "charcoal"].includes(recipe.ground));
  let recipe = pick(rand, recipes.length ? recipes : direction.recipes);
  if ((mode === "dark") !== ["ink", "deep", "charcoal"].includes(recipe.ground)) {
    recipe = { ...recipe, ground: mode === "dark" ? "charcoal" : "white" };
  }
  if (brief.moods.includes("minimal")) recipe = { ...recipe, saturation: recipe.saturation === "vivid" ? "balanced" : recipe.saturation, harmony: recipe.harmony === "triadic" ? "analogous" : recipe.harmony };
  if (brief.moods.includes("playful") || brief.moods.includes("bold")) recipe = { ...recipe, saturation: "vivid" };
  if (brief.moods.includes("premium") && !brief.moods.includes("bold")) recipe = { ...recipe, saturation: recipe.saturation === "vivid" ? "balanced" : "muted" };

  const chromatic = brief.colors.filter((c) => hexToHsl(c.hex).s > 12 && c.role !== "background" && c.role !== "text");
  const primaryRequest = chromatic.find((c) => c.role === "primary") ?? chromatic.find((c) => c.role === "any") ?? chromatic.find((c) => c.role === "accent" && chromatic.length === 1);
  const accentRequest = chromatic.find((c) => c.role === "accent" && c !== primaryRequest) ?? chromatic.find((c) => c !== primaryRequest);
  const backgroundRequest = brief.colors.find((c) => c.role === "background");
  const textRequest = brief.colors.find((c) => c.role === "text");

  let hue = primaryRequest ? hexToHsl(primaryRequest.hex).h : hueInRanges(rand, direction.hues);
  if (!primaryRequest && typeof options.avoidHue === "number") {
    for (let i = 0; i < 6 && Math.min(Math.abs(hue - options.avoidHue), 360 - Math.abs(hue - options.avoidHue)) < 50; i += 1) {
      hue = (hueInRanges(rand, direction.hues) + 70 * (i + 1)) % 360;
    }
  }
  const overrides: Partial<SitePalette> = {};
  let paletteMode = mode;
  if (backgroundRequest) {
    overrides.background = backgroundRequest.hex;
    paletteMode = hexToHsl(backgroundRequest.hex).l < 45 ? "dark" : "light";
    overrides.surface = paletteMode === "dark" ? hslToHex(hexToHsl(backgroundRequest.hex).h, Math.min(30, hexToHsl(backgroundRequest.hex).s), Math.min(18, hexToHsl(backgroundRequest.hex).l + 6)) : hexToHsl(backgroundRequest.hex).l > 98 ? hslToHex(hue, 20, 97) : "#ffffff";
  }
  if (paletteMode !== mode) recipe = { ...recipe, ground: paletteMode === "dark" ? "charcoal" : "white" };
  if (primaryRequest) overrides.primary = primaryRequest.hex;
  if (accentRequest) overrides.accent = accentRequest.hex;
  if (textRequest) overrides.text = textRequest.hex;
  const palette = buildPalette(hue, paletteMode, recipe, overrides);

  // --- typography
  const bangla = /[\u0980-\u09FF]/.test(prompt) || /\b(bangla|bengali)\b/i.test(prompt);
  const wantsSerif = brief.constraints.some((c) => /serif typeface/.test(c));
  const wantsMono = brief.constraints.some((c) => /monospace typeface/.test(c));
  const typeIds = wantsMono ? ["mono-dev"] : wantsSerif ? direction.type.filter((id) => /serif/.test(id)).concat(["editorial-serif", "classic-serif"]) : direction.type;
  let typography = typographyFrom(TYPE[pick(rand, typeIds)]);
  if (bangla && !brief.fonts.length) {
    typography = { ...typography, body: `'Hind Siliguri', ${typography.body}`, heading: `${typography.heading.replace(/, (?:system-ui|Georgia|ui-monospace).*$/, "")}, 'Hind Siliguri', system-ui, sans-serif`, googleFonts: [...typography.googleFonts, "Hind Siliguri:wght@400;500;600;700"] };
  }
  typography = fontRequest(brief.fonts, typography);

  // --- layout & navigation
  const hero = pick(rand, direction.heroes);
  const nav = pick(rand, direction.navs);
  const density = brief.moods.includes("minimal") ? "airy" : pick(rand, direction.density);
  const radius = brief.moods.includes("playful") && direction.radius.includes("xl") ? "xl" : pick(rand, direction.radius);
  const rhythmOptions = [
    "Alternate full-width tinted bands with contained sections; vary section height so the page has a clear rhythm rather than equal slabs.",
    "Keep one continuous canvas; separate sections with spacing and thin rules only, and break the grid once with an offset or full-bleed element.",
    "Use a 12-column grid with deliberate asymmetry (7/5, 8/4 splits) and one section that spans edge to edge.",
    "Lead with dense proof, then open up into wide, quiet sections; end with a compact, high-contrast closing band.",
  ];
  const gridOptions = [
    "Responsive CSS grid: 1 column on phones, 2 at ≥640px, 3–4 at ≥1024px; cards share equal heights.",
    "Mixed grid: one large feature tile beside smaller tiles (bento), collapsing to a single ordered column on phones.",
    "List-first layout: rows with media left and content right on desktop, stacked on mobile; avoids identical card walls.",
  ];

  const pages = [...new Set([...(brief.pages.length ? brief.pages : INDUSTRY_PAGES[brief.industry])])];
  const purpose = brief.purpose || `A ${brief.industry} website`;
  const moodNote = brief.moods.length ? ` Tone requested by the user: ${brief.moods.join(", ")}.` : "";

  return {
    version: 1,
    purpose,
    industry: brief.industry,
    audience: brief.audience || INDUSTRY_AUDIENCE[brief.industry],
    brand: brief.brand || options.title || "",
    direction: { name: direction.name, summary: `${direction.summary}${moodNote}` },
    palette,
    typography,
    layout: {
      hero: HERO[hero],
      sectionRhythm: pick(rand, rhythmOptions),
      grid: brief.industry === "dashboard" ? "Application grid: fixed navigation, fluid content area, KPI cards in an auto-fit grid, tables scroll horizontally inside their own container." : pick(rand, gridOptions),
      density,
      maxWidth: density === "dense" ? "max-w-screen-2xl" : density === "airy" ? "max-w-6xl" : "max-w-7xl",
      radius,
      surfaces: pick(rand, direction.surfaces),
    },
    navigation: NAV[nav],
    components: INDUSTRY_COMPONENTS[brief.industry],
    pages,
    features: brief.features,
    imagery: imageryRule(brief.industry),
    responsive: [
      "Mobile-first: design the 360–430px layout first, then enhance at sm (640), md (768), lg (1024) and xl (1280).",
      "No horizontal scrolling at any width; long words, tables and code wrap or scroll inside their own container.",
      "Tap targets ≥ 44px; body text ≥ 16px on phones; headings scale with clamp() or responsive utilities.",
      "Navigation collapses to the mobile pattern described; it must open, close and be keyboard operable.",
      "Images and embeds use max-width: 100% with a reserved aspect ratio to prevent layout shift.",
    ],
    animation: `${pick(rand, direction.motion)} Honour prefers-reduced-motion by disabling non-essential motion.`,
    accessibility: [
      "Semantic landmarks (header, nav, main, footer) and one h1 per page with a logical heading order.",
      "Text contrast ≥ 4.5:1 (≥ 3:1 for large text and UI); never place text on imagery without a scrim.",
      "Visible focus styles on every interactive element; a skip-to-content link.",
      "Form fields have associated labels, helpful error text and correct input types/autocomplete.",
      "Meaningful alt text; decorative images use empty alt. Language set on <html>.",
    ],
    userConstraints: brief.constraints,
    references: brief.references,
    source: "heuristic",
    seed,
  };
}

// ---------------------------------------------------------------------------
// Design revisions
// ---------------------------------------------------------------------------

export type RevisionScope = "full-redesign" | "palette" | "typography" | "navigation" | "hero" | "mobile" | "layout" | "add-page" | "none";

export type DesignRevision = {
  /** Aspects of the design the user asked to change. Empty = not a design request. */
  scopes: RevisionScope[];
  /** True when the visual identity itself must change. */
  restyle: boolean;
};

const REDESIGN_RE = /\b(redesign|re-design|revamp|overhaul|restyle|re-style|make ?over|new (?:design|look|theme|style)|different (?:design|look|style|theme)|change the (?:whole|entire|complete|overall) (?:design|look|theme|style)|complete(?:ly)? (?:new|different|change)|from scratch|look (?:like|more like)|make (?:it|this|the (?:site|website|page|design))\s+(?:look\s+)?(?:more\s+)?(?:premium|minimal\w*|modern|professional|luxur\w+|elegant|bold|playful|clean|dark|light|corporate|creative|futuristic|beautiful|attractive|stunning|better|nicer)|ডিজাইন (?:পরিবর্তন|চেঞ্জ|বদল)|নতুন ডিজাইন)\b/i;
const PALETTE_RE = /\b(colou?rs?|palette|colou?r scheme|theme colou?r|background colou?r|dark mode|light mode|dark theme|light theme|রঙ|রং|কালার)\b/i;
const TYPE_RE = /\b(fonts?|typograph\w+|typeface|headings? (?:style|font)|ফন্ট)\b/i;
const NAV_RE = /\b(nav(?:igation|bar)?|menu bar|header|hamburger|sidebar|top bar|মেনু|নেভিগেশন)\b/i;
const HERO_RE = /\b(hero|banner|above the fold|landing section|first section|হিরো)\b/i;
const MOBILE_RE = /\b(mobile(?! number)|phones?(?! number)|responsive|small screens?|tablet|android|iphone)\b|মোবাইল/i;
const WHOLE_SITE_RE = /\b(entire|whole|complete(?:ly)?|overall|everything|website|web ?site|site|from scratch|all pages)\b/i;
const LAYOUT_RE = /\b(layout|spacing|grid|sections? (?:order|arrangement)|alignment|whitespace|padding|margins?|লেআউট)\b/i;
const ADD_PAGE_RE = /\b(add|create|make|build|include|need|want)\b[^.\n]{0,40}\b(?:new\s+)?(?:[\w-]+\s+){0,3}page\b|নতুন পেজ|পেজ যোগ/i;
const CHANGE_VERB_RE = /\b(change|update|replace|redo|redesign|improve|fix|make|switch|use|apply|modernis?e|refresh|polish|rework|adjust|tweak|convert|turn|give|set|পরিবর্তন|বদল|ঠিক)\b/i;

/** What kind of design change is this follow-up asking for? */
export function classifyDesignRevision(prompt: string): DesignRevision {
  const text = String(prompt ?? "");
  const scopes: RevisionScope[] = [];
  const changing = CHANGE_VERB_RE.test(text);
  const redesign = REDESIGN_RE.test(text);
  if (changing && PALETTE_RE.test(text)) scopes.push("palette");
  if (changing && TYPE_RE.test(text)) scopes.push("typography");
  if (changing && NAV_RE.test(text)) scopes.push("navigation");
  if (changing && HERO_RE.test(text)) scopes.push("hero");
  if (changing && MOBILE_RE.test(text)) scopes.push("mobile");
  if (changing && LAYOUT_RE.test(text)) scopes.push("layout");
  if (ADD_PAGE_RE.test(text)) scopes.push("add-page");
  // "Redesign the navigation" is a navigation change, not a whole-site redesign.
  const partOnly = scopes.some((scope) => scope === "navigation" || scope === "hero" || scope === "mobile") && !WHOLE_SITE_RE.test(text);
  if (redesign && !partOnly) scopes.unshift("full-redesign");
  const restyle = scopes.some((scope) => scope === "full-redesign" || scope === "palette" || scope === "typography");
  return { scopes: scopes.length ? scopes : ["none"], restyle };
}

/**
 * Produce the specification an edit should aim for.
 *
 * Only the aspects the user asked to change are regenerated; everything else
 * is carried over so an "update the colours" request does not also move the
 * navigation. A full redesign regenerates the whole spec and steers away
 * from the direction and hue being replaced, so the result is visibly new.
 */
export function reviseDesignSpec(existing: SiteDesignSpec | null, prompt: string, options: { seed: string; originalBrief?: string; title?: string }): { spec: SiteDesignSpec; revision: DesignRevision; changed: string[] } {
  const revision = classifyDesignRevision(prompt);
  const brief = `${options.originalBrief ?? existing?.purpose ?? ""}\n${prompt}`.trim();
  if (!existing) {
    return { spec: createDesignSpec(brief, { seed: options.seed, title: options.title }), revision, changed: ["all"] };
  }
  if (revision.scopes.includes("none") && revision.scopes.length === 1) return { spec: existing, revision, changed: [] };

  const request = analyzeBrief(prompt);
  const fresh = createDesignSpec(
    // The follow-up's own words decide the new look; the original brief only supplies the industry.
    `${prompt}\n(${existing.industry} website${existing.brand ? ` for ${existing.brand}` : ""})`,
    {
      seed: options.seed,
      title: options.title,
      avoidDirections: revision.scopes.includes("full-redesign") ? [existing.direction.name] : [],
      avoidHue: revision.restyle && !request.colors.length ? hexToHsl(existing.palette.primary).h : null,
    },
  );
  // Industry comes from the project, not from the wording of a short follow-up.
  const industry = request.industryConfidence >= 4 ? fresh.industry : existing.industry;
  const changed: string[] = [];
  let spec: SiteDesignSpec = { ...existing, seed: options.seed, source: "heuristic" };
  if (revision.scopes.includes("full-redesign")) {
    spec = { ...fresh, industry, purpose: existing.purpose, audience: existing.audience, brand: existing.brand || fresh.brand, components: industry === existing.industry ? existing.components : fresh.components, pages: [...new Set([...existing.pages, ...request.pages])], features: [...new Set([...existing.features, ...request.features])], imagery: industry === existing.industry ? existing.imagery : fresh.imagery };
    changed.push("direction", "palette", "typography", "layout", "navigation", "animation");
  } else {
    if (revision.scopes.includes("palette")) { spec = { ...spec, palette: fresh.palette }; changed.push("palette"); }
    if (revision.scopes.includes("typography")) { spec = { ...spec, typography: fresh.typography }; changed.push("typography"); }
    if (revision.scopes.includes("navigation")) {
      const other = Object.values(NAV).filter((nav) => nav.style !== existing.navigation.style);
      const rand = seededRandom(`${options.seed}|nav`);
      spec = { ...spec, navigation: fresh.navigation.style !== existing.navigation.style ? fresh.navigation : pick(rand, other) };
      changed.push("navigation");
    }
    if (revision.scopes.includes("hero")) {
      const other = Object.values(HERO).filter((hero) => hero !== existing.layout.hero && hero !== HERO["app-shell"] && hero !== HERO.masthead);
      const rand = seededRandom(`${options.seed}|hero`);
      spec = { ...spec, layout: { ...spec.layout, hero: fresh.layout.hero !== existing.layout.hero ? fresh.layout.hero : pick(rand, other) } };
      changed.push("hero");
    }
    if (revision.scopes.includes("layout")) { spec = { ...spec, layout: { ...fresh.layout, hero: spec.layout.hero } }; changed.push("layout"); }
    if (revision.scopes.includes("mobile")) changed.push("responsive");
    if (revision.scopes.includes("add-page")) { spec = { ...spec, pages: [...new Set([...spec.pages, ...request.pages])] }; changed.push("pages"); }
  }
  spec = { ...spec, userConstraints: [...new Set([...request.constraints, ...existing.userConstraints.filter((c) => !revision.restyle || !/colour|theme|font|mood|typeface/i.test(c))])].slice(0, 12), references: [...new Set([...request.references, ...existing.references])].slice(0, 6) };
  return { spec, revision, changed };
}

// ---------------------------------------------------------------------------
// Understanding an existing project's design
// ---------------------------------------------------------------------------

export type DesignFingerprint = {
  colors: string[];
  fonts: string[];
  usesTailwind: boolean;
  pages: string[];
  hasMobileMenu: boolean;
  sections: number;
};

/** Read the current look from real source files (for edits of projects that
 * pre-date stored specs, and for verifying that a redesign changed something). */
export function designFingerprint(files: Array<{ path: string; content: string; encoding?: string }>): DesignFingerprint {
  const text = files.filter((file) => file.encoding !== "base64" && /\.(?:html?|css|js|jsx|tsx|vue|svelte)$/i.test(file.path));
  const joined = text.map((file) => file.content).join("\n");
  const counts = new Map<string, number>();
  for (const m of joined.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = normalizeHex(m[0]);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const fonts = new Set<string>();
  for (const m of joined.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const first = m[1].split(",")[0].trim().replace(/^['"]|['"]$/g, "");
    if (first && !/^(inherit|var\(|ui-|system-ui|sans-serif|serif|monospace)/i.test(first)) fonts.add(first);
  }
  for (const m of joined.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)) {
    for (const family of m[1].matchAll(/family=([^:&]+)/g)) fonts.add(decodeURIComponent(family[1]).replace(/\+/g, " "));
  }
  const html = text.filter((file) => /\.html?$/i.test(file.path));
  return {
    colors: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hex]) => hex),
    fonts: [...fonts].slice(0, 6),
    usesTailwind: /cdn\.tailwindcss\.com|@tailwindcss\/browser|tailwind\.config/i.test(joined),
    pages: html.map((file) => file.path),
    hasMobileMenu: /aria-expanded|hamburger|menu-toggle|mobile-menu|nav-toggle/i.test(joined),
    sections: (joined.match(/<section\b/gi) ?? []).length,
  };
}

/** 0 = identical look, 1 = nothing in common. Used by tests and the pipeline's change check. */
export function designDistance(a: SiteDesignSpec, b: SiteDesignSpec): number {
  const hueGap = (x: string, y: string) => { const d = Math.abs(hexToHsl(x).h - hexToHsl(y).h); return Math.min(d, 360 - d) / 180; };
  const parts = [
    a.direction.name === b.direction.name ? 0 : 1,
    a.palette.mode === b.palette.mode ? 0 : 1,
    Math.min(1, hueGap(a.palette.primary, b.palette.primary) * 2),
    a.typography.heading === b.typography.heading ? 0 : 1,
    a.layout.hero === b.layout.hero ? 0 : 1,
    a.navigation.style === b.navigation.style ? 0 : 1,
    a.layout.radius === b.layout.radius ? 0 : 0.5,
    a.layout.sectionRhythm === b.layout.sectionRhythm ? 0 : 0.5,
  ];
  return parts.reduce((sum, value) => sum + value, 0) / 7;
}

// ---------------------------------------------------------------------------
// Model refinement (the AI part of the planning stage)
// ---------------------------------------------------------------------------

const hex = z.string().transform((value, ctx) => {
  const normalized = normalizeHex(value);
  if (!normalized) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not a hex colour" }); return z.NEVER; }
  return normalized;
});
const shortText = (max: number) => z.string().trim().min(2).max(max);

const modelSpecSchema = z.object({
  purpose: shortText(240).optional(),
  audience: shortText(200).optional(),
  brand: z.string().trim().max(60).optional(),
  direction: z.object({ name: shortText(60), summary: shortText(400) }).partial().optional(),
  palette: z.object({ mode: z.enum(["light", "dark"]), background: hex, surface: hex, text: hex, muted: hex, border: hex, primary: hex, accent: hex }).partial().optional(),
  typography: z.object({ heading: shortText(60), body: shortText(60) }).partial().optional(),
  layout: z.object({ hero: shortText(400), sectionRhythm: shortText(400), grid: shortText(400), surfaces: shortText(400) }).partial().optional(),
  navigation: z.object({ style: shortText(400), mobile: shortText(400) }).partial().optional(),
  components: z.array(shortText(140)).max(12).optional(),
  pages: z.array(shortText(40)).max(12).optional(),
  animation: shortText(300).optional(),
}).partial();

/** Prompt asking the model to act as the art director for THIS brief. */
export function designPlanPrompt(brief: string, baseline: SiteDesignSpec, existing?: DesignFingerprint | null): string {
  return [
    "You are the art director for one specific website. Decide its visual design BEFORE any code is written.",
    "Return ONLY a JSON object (no prose, no code fence) with any of these keys:",
    `{"purpose","audience","brand","direction":{"name","summary"},"palette":{"mode":"light|dark","background","surface","text","muted","border","primary","accent"},"typography":{"heading","body"},"layout":{"hero","sectionRhythm","grid","surfaces"},"navigation":{"style","mobile"},"components":[...],"pages":[...],"animation"}`,
    "Rules:",
    "- Everything the user explicitly asked for (colours, fonts, mood, pages, references) is mandatory.",
    "- Design for this brand, audience and industry specifically. Do NOT default to a generic blue SaaS landing page, a centred gradient hero, or three identical feature cards unless the brief truly calls for it.",
    "- Colours are #rrggbb. Text on background must reach 4.5:1 contrast. Typography values are Google Fonts family names.",
    "- Describe layout and navigation concretely (what goes where on desktop and on a 390px phone).",
    "- Omit a key to accept the proposal below for that aspect.",
    "",
    `USER BRIEF:\n${brief.slice(0, 3000)}`,
    existing && (existing.colors.length || existing.fonts.length)
      ? `\nCURRENT DESIGN OF THE EXISTING PROJECT (being revised): colours ${existing.colors.join(", ") || "n/a"}; fonts ${existing.fonts.join(", ") || "n/a"}; ${existing.pages.length} page(s); ${existing.usesTailwind ? "Tailwind" : "custom CSS"}.`
      : "",
    `\nSTARTING PROPOSAL (improve it where the brief suggests something better):\n${JSON.stringify({ direction: baseline.direction, palette: baseline.palette, typography: { heading: baseline.typography.heading.split(",")[0].replace(/'/g, ""), body: baseline.typography.body.split(",")[0].replace(/'/g, "") }, layout: { hero: baseline.layout.hero, sectionRhythm: baseline.layout.sectionRhythm }, navigation: baseline.navigation, pages: baseline.pages }, null, 0)}`,
  ].filter(Boolean).join("\n");
}

function extractJsonObject(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function googleFamily(name: string): string | null {
  const clean = name.replace(/['"]/g, "").split(",")[0].trim();
  if (!clean || clean.length > 40 || !/^[A-Za-z0-9 ]+$/.test(clean)) return null;
  if (/^(system-ui|sans-serif|serif|monospace|ui-sans-serif|ui-serif|ui-monospace|arial|helvetica|georgia|times new roman|verdana|tahoma)$/i.test(clean)) return null;
  return clean;
}

/**
 * Merge the model's proposal over the baseline. The model is an adviser:
 * its output is schema-validated, colours are repaired to AA contrast, and
 * anything the user explicitly required is re-applied on top.
 */
export function mergeModelDesignSpec(baseline: SiteDesignSpec, rawModelOutput: string, brief: string): { spec: SiteDesignSpec; applied: string[]; rejected: string[] } {
  const parsed = modelSpecSchema.safeParse(extractJsonObject(rawModelOutput));
  if (!parsed.success || !parsed.data) return { spec: baseline, applied: [], rejected: ["model design plan was not valid JSON for the schema"] };
  const proposal = parsed.data;
  const analysis = analyzeBrief(brief);
  const applied: string[] = [];
  const rejected: string[] = [];
  let spec: SiteDesignSpec = { ...baseline };

  if (proposal.purpose) { spec.purpose = proposal.purpose; applied.push("purpose"); }
  if (proposal.audience) { spec.audience = proposal.audience; applied.push("audience"); }
  if (proposal.brand && !analysis.brand) spec.brand = proposal.brand;
  if (proposal.direction?.name && proposal.direction.summary) { spec.direction = { name: proposal.direction.name, summary: proposal.direction.summary }; applied.push("direction"); }

  if (proposal.palette) {
    const userFixed = (role: string) => analysis.colors.some((c) => c.role === role || (role === "primary" && c.role === "any"));
    const next: SitePalette = { ...spec.palette };
    const p = proposal.palette;
    if (!analysis.mode && !userFixed("background") && p.mode) next.mode = p.mode;
    if (!userFixed("background") && p.background && (!analysis.mode || (hexToHsl(p.background).l < 45) === (analysis.mode === "dark"))) next.background = p.background;
    if (p.surface && !userFixed("background")) next.surface = p.surface;
    if (!userFixed("text") && p.text) next.text = p.text;
    if (p.muted) next.muted = p.muted;
    if (p.border) next.border = p.border;
    if (!userFixed("primary") && p.primary) next.primary = p.primary;
    if (!userFixed("accent") && p.accent) next.accent = p.accent;
    next.mode = hexToHsl(next.background).l < 45 ? "dark" : "light";
    const before = paletteIssues(next);
    spec.palette = repairPalette(next);
    applied.push("palette");
    if (before.length) rejected.push(`palette contrast repaired (${before.join("; ")})`);
  }

  if (proposal.typography && !analysis.fonts.length) {
    const heading = proposal.typography.heading ? googleFamily(proposal.typography.heading) : null;
    const body = proposal.typography.body ? googleFamily(proposal.typography.body) : null;
    if (heading || body) {
      const stackOf = (name: string, fallback: string) => `'${name}', ${/mono/i.test(name) ? "ui-monospace, monospace" : /serif|playfair|garamond|fraunces|lora|merriweather|baskerville|newsreader/i.test(name) && !/sans/i.test(name) ? "Georgia, serif" : fallback}`;
      spec.typography = {
        ...spec.typography,
        heading: heading ? stackOf(heading, "system-ui, sans-serif") : spec.typography.heading,
        body: body ? stackOf(body, "system-ui, sans-serif") : spec.typography.body,
        googleFonts: [...new Set([...(heading ? [`${heading}:wght@400;500;600;700`] : spec.typography.googleFonts.slice(0, 1)), ...(body ? [`${body}:wght@400;500;600;700`] : spec.typography.googleFonts.slice(1))])].slice(0, 3),
      };
      applied.push("typography");
    }
  }
  if (proposal.layout) {
    spec.layout = { ...spec.layout, ...Object.fromEntries(Object.entries(proposal.layout).filter(([, value]) => typeof value === "string" && value)) };
    applied.push("layout");
  }
  if (proposal.navigation?.style) {
    spec.navigation = { style: proposal.navigation.style, mobile: proposal.navigation.mobile ?? spec.navigation.mobile };
    applied.push("navigation");
  }
  if (proposal.components?.length) { spec.components = proposal.components; applied.push("components"); }
  if (proposal.pages?.length) { spec.pages = [...new Set([...analysis.pages, ...proposal.pages])].slice(0, 12); applied.push("pages"); }
  if (proposal.animation) spec.animation = `${proposal.animation} Honour prefers-reduced-motion by disabling non-essential motion.`;
  spec = { ...spec, source: applied.length ? "model-refined" : baseline.source };
  return { spec, applied, rejected };
}

// ---------------------------------------------------------------------------
// Prompt + Tailwind output
// ---------------------------------------------------------------------------

const RADIUS_CLASS: Record<SiteDesignSpec["layout"]["radius"], string> = {
  none: "rounded-none (square corners everywhere)", sm: "rounded (4px)", md: "rounded-lg (8px)", lg: "rounded-2xl (16px)", xl: "rounded-3xl (24px)", full: "rounded-full pills for buttons and tags; rounded-3xl for cards",
};

/** Google Fonts stylesheet URL for the spec ("" when the system stack is used). */
export function googleFontsUrl(spec: SiteDesignSpec): string {
  if (!spec.typography.googleFonts.length) return "";
  const families = spec.typography.googleFonts.map((family) => `family=${family.replace(/ /g, "+")}`).join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/** The exact Tailwind Play-CDN configuration the generated site must use. */
export function tailwindConfigSnippet(spec: SiteDesignSpec): string {
  const p = spec.palette;
  const config = {
    theme: {
      extend: {
        colors: { background: p.background, surface: p.surface, ink: p.text, muted: p.muted, line: p.border, primary: p.primary, "on-primary": p.onPrimary, accent: p.accent },
        fontFamily: { heading: spec.typography.heading.split(",").map((s) => s.trim().replace(/^'|'$/g, "")), body: spec.typography.body.split(",").map((s) => s.trim().replace(/^'|'$/g, "")) },
      },
    },
  };
  const fonts = googleFontsUrl(spec);
  return [
    fonts ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="${fonts}" rel="stylesheet">` : "",
    `<script src="https://cdn.tailwindcss.com"></script>`,
    `<script>tailwind.config = ${JSON.stringify(config)};</script>`,
  ].filter(Boolean).join("\n");
}

/** The Design Specification as the coding model reads it. */
export function formatDesignSpecForPrompt(spec: SiteDesignSpec, options: { changed?: string[]; edit?: boolean } = {}): string {
  const p = spec.palette;
  const t = spec.typography;
  const scale = t.scale === "dramatic" ? "Dramatic scale: hero headline clamp(2.75rem, 7vw, 5.5rem); section headings 2–3rem; body 1–1.125rem." : t.scale === "compact" ? "Compact scale: page titles 1.5–2rem; section headings 1.125–1.5rem; body 0.875–1rem." : "Balanced scale: hero headline clamp(2.25rem, 5vw, 4rem); section headings 1.75–2.5rem; body 1–1.125rem.";
  const lines = [
    "=== DESIGN SPECIFICATION (binding — the generated code must implement this, not a generic layout) ===",
    `Purpose: ${spec.purpose}`,
    `Industry: ${spec.industry}. Audience: ${spec.audience}.${spec.brand ? ` Brand: ${spec.brand}.` : ""}`,
    `Design direction — ${spec.direction.name}: ${spec.direction.summary}`,
    `Palette (${p.mode}): background ${p.background}; surface ${p.surface}; text ${p.text}; muted text ${p.muted}; border ${p.border}; primary ${p.primary} (text on it ${p.onPrimary}); accent ${p.accent}. Use ONLY these colours plus tints/shades of them and semantic status colours. Primary is for main actions and key emphasis; accent is used sparingly.`,
    `Typography: headings ${t.heading} at weight ${t.headingWeight}, ${t.headingTracking} tracking${t.headingCase === "uppercase" ? ", UPPERCASE" : ""}; body ${t.body}. ${scale} Line length 60–75 characters for prose.`,
    `Hero: ${spec.layout.hero}`,
    `Section rhythm: ${spec.layout.sectionRhythm}`,
    `Grid: ${spec.layout.grid}`,
    `Density ${spec.layout.density}; content width ${spec.layout.maxWidth}; corners ${RADIUS_CLASS[spec.layout.radius]}. Surfaces: ${spec.layout.surfaces}`,
    `Navigation: ${spec.navigation.style}`,
    `Mobile navigation: ${spec.navigation.mobile}`,
    `Content blocks to cover (adapt, reorder or replace to fit the brief — these are not a fixed template): ${spec.components.join("; ")}.`,
    `Pages: ${spec.pages.join(", ")}.${spec.pages.length > 1 ? " Each listed page that the user asked for must exist as its own .html file and be linked from the navigation on every page." : ""}`,
    spec.features.length ? `Required functionality (must actually work in JavaScript): ${spec.features.join("; ")}.` : "",
    `Imagery: ${spec.imagery}`,
    `Responsive behaviour:\n${spec.responsive.map((line) => `  - ${line}`).join("\n")}`,
    `Motion: ${spec.animation}`,
    `Accessibility:\n${spec.accessibility.map((line) => `  - ${line}`).join("\n")}`,
    spec.userConstraints.length ? `USER REQUIREMENTS (highest priority — never override):\n${spec.userConstraints.map((line) => `  - ${line}`).join("\n")}` : "",
    spec.references.length ? `Visual references given by the user: ${spec.references.join(", ")}.` : "",
    "",
    "Tailwind setup — put exactly this in <head> of every page and style with Tailwind utility classes that use these tokens (bg-background, bg-surface, text-ink, text-muted, border-line, bg-primary, text-on-primary, text-accent, font-heading, font-body):",
    tailwindConfigSnippet(spec),
    options.edit && options.changed?.length ? `\nThis is a REVISION. Aspects that must visibly change: ${options.changed.join(", ")}. Everything else in the existing project stays as it is.` : "",
    "=== END DESIGN SPECIFICATION ===",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** Compact, storable form (Firestore-safe: plain JSON, bounded size). */
export function serializeDesignSpec(spec: SiteDesignSpec): Record<string, unknown> {
  return JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
}

const storedSpecSchema = z.object({
  version: z.literal(1),
  purpose: z.string(), industry: z.enum(SITE_INDUSTRIES), audience: z.string(), brand: z.string(),
  direction: z.object({ name: z.string(), summary: z.string() }),
  palette: z.object({ mode: z.enum(["light", "dark"]), background: z.string(), surface: z.string(), text: z.string(), muted: z.string(), border: z.string(), primary: z.string(), onPrimary: z.string(), accent: z.string() }),
  typography: z.object({ heading: z.string(), body: z.string(), googleFonts: z.array(z.string()), scale: z.enum(["compact", "balanced", "dramatic"]), headingWeight: z.number(), headingTracking: z.enum(["tight", "normal", "wide"]), headingCase: z.enum(["normal", "uppercase"]) }),
  layout: z.object({ hero: z.string(), sectionRhythm: z.string(), grid: z.string(), density: z.enum(["airy", "balanced", "dense"]), maxWidth: z.string(), radius: z.enum(["none", "sm", "md", "lg", "xl", "full"]), surfaces: z.string() }),
  navigation: z.object({ style: z.string(), mobile: z.string() }),
  components: z.array(z.string()), pages: z.array(z.string()), features: z.array(z.string()),
  imagery: z.string(), responsive: z.array(z.string()), animation: z.string(), accessibility: z.array(z.string()),
  userConstraints: z.array(z.string()), references: z.array(z.string()),
  source: z.enum(["heuristic", "model-refined"]), seed: z.string(),
});

/** Read a stored spec back; null for missing/legacy/corrupt data. */
export function parseStoredDesignSpec(value: unknown): SiteDesignSpec | null {
  const parsed = storedSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Does this request produce a web page at all (vs. a script, API or library)? */
export function isWebsiteRequest(prompt: string, existingPaths: string[] = []): boolean {
  if (existingPaths.some((path) => /\.html?$/i.test(path))) return true;
  return /\b(website|web ?site|web ?page|landing|home ?page|portfolio|store|shop|blog|dashboard|web ?app|site|page|ui|frontend|front-end|html|ওয়েবসাইট|সাইট|পেজ)\b/i.test(prompt);
}
