"use client";

import { Card } from "@/components/ui";
import { useI18n } from "@/lib/i18n/client";
import { LOCALES, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LanguagePanel() {
  const { locale, setLocale, t } = useI18n();

  return (
    <Card>
      <h2 className="font-bold text-ink">{t("settings.title")} · Language</h2>
      <p className="mt-1 text-sm text-ink-2">
        Navigation, chat prompts and common labels switch immediately. More screens pick up translations over time.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Language">
        {LOCALES.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={locale === l.id}
            onClick={() => setLocale(l.id as Locale)}
            className={cn(
              "card card-hover flex min-h-20 items-center justify-between !p-4 text-left",
              locale === l.id && "!border-accent ring-2 ring-accent/40",
            )}
          >
            <span>
              <span className="block font-bold text-ink">{l.label}</span>
              <span className="block text-xs text-ink-3">{l.id === "bn" ? "বাংলা" : "English"}</span>
            </span>
            {locale === l.id ? <span className="text-accent">✓</span> : null}
          </button>
        ))}
      </div>
    </Card>
  );
}
