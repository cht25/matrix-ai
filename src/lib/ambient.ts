// QORVYNA ambient background — a static brand glow behind every page.
//
// It is pure CSS (styles/base.css paints `--bg-grad` at `--ambient` strength):
// no canvas, no animation frame, no work while scrolling or typing. The only
// script involved is the one-line attribute the root layout sets before first
// paint, so the chosen strength never flashes.
//
// The preference is stored under its original key so a choice made before the
// rebrand ("off", "subtle", …) keeps applying.

export const AMBIENT_STORAGE_KEY = "matrix-rain";
export const AMBIENT_ATTRIBUTE = "data-ambient";
export type AmbientSetting = "off" | "subtle" | "normal" | "heavy";
export const DEFAULT_AMBIENT: AmbientSetting = "normal";

export function isAmbientSetting(value: unknown): value is AmbientSetting {
  return value === "off" || value === "subtle" || value === "normal" || value === "heavy";
}

export function readAmbientSetting(): AmbientSetting {
  if (typeof window === "undefined") return DEFAULT_AMBIENT;
  try {
    const raw = window.localStorage.getItem(AMBIENT_STORAGE_KEY);
    if (isAmbientSetting(raw)) return raw;
  } catch {
    /* private browsing */
  }
  return DEFAULT_AMBIENT;
}

export function applyAmbientSetting(setting: AmbientSetting): void {
  try {
    window.localStorage.setItem(AMBIENT_STORAGE_KEY, setting);
  } catch {
    /* private browsing */
  }
  document.documentElement.setAttribute(AMBIENT_ATTRIBUTE, setting);
}
