// Minimal i18n layer: English + Bangla dictionaries, no hardcoded shell
// strings. `locale` is read from the ?lang= query or a cookie, defaulting to en.

import { en } from "./en";
import { bn } from "./bn";

export type Locale = "en" | "bn";
export type TranslationKey = keyof typeof en;

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en, bn };

export function getLocale(preferred?: string | null): Locale {
  if (preferred === "bn" || preferred === "en") return preferred;
  return "en";
}

export function t(key: TranslationKey, locale: Locale): string {
  return dictionaries[locale][key] ?? en[key] ?? key;
}

export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "bn", label: "বাংলা" },
];
