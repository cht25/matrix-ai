"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

const LANGUAGES = [
  { id: "en", label: "English", native: "English" },
  { id: "bn", label: "Bangla", native: "বাংলা" },
];

export function LanguagePanel() {
  const [lang, setLang] = useState<string>("en");

  useEffect(() => {
    setLang(localStorage.getItem("matrix-lang") ?? "en");
  }, []);

  function choose(id: string) {
    setLang(id);
    localStorage.setItem("matrix-lang", id);
    document.documentElement.setAttribute("lang", id);
  }

  return (
    <Card>
      <h2 className="font-bold text-ink">Language</h2>
      <p className="mt-1 text-sm text-ink-2">
        MATRIX is built with an internationalization layer (English and Bangla today) — more languages
        are on the way.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Language">
        {LANGUAGES.map((l) => (
          <button
            key={l.id}
            role="radio"
            aria-checked={lang === l.id}
            onClick={() => choose(l.id)}
            className={cn(
              "card card-hover flex min-h-20 items-center justify-between !p-4 text-left",
              lang === l.id && "!border-accent ring-2 ring-accent/40",
            )}
          >
            <span>
              <span className="block font-bold text-ink">{l.label}</span>
              <span className="block text-xs text-ink-3">{l.native}</span>
            </span>
            {lang === l.id ? <span className="text-accent">✓</span> : null}
          </button>
        ))}
      </div>
    </Card>
  );
}
