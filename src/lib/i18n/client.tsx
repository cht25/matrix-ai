"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getLocale, t as translate, type Locale, type TranslationKey } from "./index";

type I18nCtx = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
};

const Ctx = createContext<I18nCtx>({
  locale: "en",
  setLocale: () => {},
  t: (key) => translate(key, "en"),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const stored = getLocale(localStorage.getItem("matrix-lang"));
    setLocaleState(stored);
    document.documentElement.setAttribute("lang", stored);
  }, []);

  const value = useMemo<I18nCtx>(
    () => ({
      locale,
      setLocale: (next) => {
        localStorage.setItem("matrix-lang", next);
        document.documentElement.setAttribute("lang", next);
        setLocaleState(next);
      },
      t: (key) => translate(key, locale),
    }),
    [locale],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}
