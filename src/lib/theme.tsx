"use client";

// Theme system: dark (default) · light · system, persisted in localStorage.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light" | "system";
const KEY = "matrix-theme";

type ThemeCtx = {
  theme: Theme;
  resolved: "dark" | "light";
  setTheme: (t: Theme) => void;
};

const Ctx = createContext<ThemeCtx>({ theme: "dark", resolved: "dark", setTheme: () => {} });

export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [resolved, setResolved] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as Theme | null) ?? "dark";
    setThemeState(stored);
    setResolved(resolveTheme(stored));
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onMedia = () => {
      setThemeState((t) => {
        if (t === "system") setResolved(resolveTheme("system"));
        return t;
      });
    };
    mq.addEventListener("change", onMedia);
    return () => mq.removeEventListener("change", onMedia);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  const value = useMemo<ThemeCtx>(
    () => ({
      theme,
      resolved,
      setTheme: (t) => {
        localStorage.setItem(KEY, t);
        setThemeState(t);
        setResolved(resolveTheme(t));
      },
    }),
    [theme, resolved],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}

const ORDER: Theme[] = ["dark", "light", "system"];
const LABELS: Record<Theme, string> = { dark: "Dark", light: "Light", system: "System" };
const ICONS: Record<Theme, string> = { dark: "🌙", light: "☀️", system: "🖥️" };

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABELS[theme]}. Switch to ${LABELS[next]}.`}
      title={`Theme: ${LABELS[theme]} — click to switch to ${LABELS[next]}`}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-ink-2 transition-colors hover:border-border-strong hover:text-ink"
    >
      <span aria-hidden="true">{ICONS[theme]}</span>
      {!compact ? LABELS[theme] : null}
    </button>
  );
}
