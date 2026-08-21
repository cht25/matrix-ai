export type ThemeMode = "dark" | "light" | "system";
export type ThemeTemplateId = "default" | "midnight" | "ivory" | "carbon" | "aurora" | "forest";

export type ThemeSwatch = {
  bg: string;
  surface: string;
  ink: string;
  accent: string;
};

export type ThemeTemplate = {
  id: ThemeTemplateId;
  name: string;
  description: string;
  dark: ThemeSwatch;
  light: ThemeSwatch;
};

export const THEME_TEMPLATES: ThemeTemplate[] = [
  {
    id: "default",
    name: "MATRIX Default",
    description: "Obsidian ground, steel-blue calligraphy — the original identity.",
    dark: { bg: "#070b14", surface: "#0d1424", ink: "#f8fafc", accent: "#3b82f6" },
    light: { bg: "#f6f8fc", surface: "#ffffff", ink: "#0f172a", accent: "#2563eb" },
  },
  {
    id: "midnight",
    name: "Midnight Ink",
    description: "Deeper navy void with electric indigo strokes.",
    dark: { bg: "#020617", surface: "#0b1224", ink: "#e0e7ff", accent: "#6366f1" },
    light: { bg: "#eef2ff", surface: "#ffffff", ink: "#1e1b4b", accent: "#4338ca" },
  },
  {
    id: "ivory",
    name: "Ivory Editorial",
    description: "Warm paper, charcoal type, restrained gold accent.",
    dark: { bg: "#14110d", surface: "#1c1812", ink: "#f4efe4", accent: "#d4a017" },
    light: { bg: "#f7f1e6", surface: "#fffaf1", ink: "#1c1610", accent: "#9a6b12" },
  },
  {
    id: "carbon",
    name: "Carbon Steel",
    description: "Graphite industrial surfaces with a cool silver edge.",
    dark: { bg: "#0a0b0d", surface: "#14161a", ink: "#eceff3", accent: "#94a3b8" },
    light: { bg: "#e8eaee", surface: "#ffffff", ink: "#111318", accent: "#334155" },
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Cool twilight with a teal-cyan signal light.",
    dark: { bg: "#041016", surface: "#0b1c24", ink: "#e7fbff", accent: "#22d3ee" },
    light: { bg: "#ecfeff", surface: "#ffffff", ink: "#083344", accent: "#0e7490" },
  },
  {
    id: "forest",
    name: "Forest Signal",
    description: "Moss and night pine with a clear safety-green accent.",
    dark: { bg: "#07140d", surface: "#0e1d14", ink: "#e8f6ec", accent: "#4ade80" },
    light: { bg: "#f0f7f2", surface: "#ffffff", ink: "#102016", accent: "#15803d" },
  },
];

export function isThemeTemplateId(value: unknown): value is ThemeTemplateId {
  return THEME_TEMPLATES.some((t) => t.id === value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

export function templateById(id: string | null | undefined): ThemeTemplate {
  return THEME_TEMPLATES.find((t) => t.id === id) ?? THEME_TEMPLATES[0];
}
