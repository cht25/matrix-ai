"use client";

// Theme system: dark · light · system + per-user template palettes.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { isThemeMode, isThemeTemplateId, type ThemeMode, type ThemeTemplateId } from "@/lib/theme-templates";

export type Theme = ThemeMode;
const KEY = "matrix-theme";
const TEMPLATE_KEY = "matrix-theme-template";

type ThemeCtx = {
  theme: Theme;
  template: ThemeTemplateId;
  resolved: "dark" | "light";
  setTheme: (t: Theme) => void;
  setTemplate: (t: ThemeTemplateId) => void;
};

const Ctx = createContext<ThemeCtx>({
  theme: "dark",
  template: "default",
  resolved: "dark",
  setTheme: () => {},
  setTemplate: () => {},
});

export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

function applyDom(resolved: "dark" | "light", template: ThemeTemplateId) {
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-template", template);
}

export function ThemeProvider({
  children,
  initialTheme,
  initialTemplate,
  persistAccount = false,
}: {
  children: ReactNode;
  initialTheme?: Theme;
  initialTemplate?: ThemeTemplateId;
  persistAccount?: boolean;
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme ?? "dark");
  const [template, setTemplateState] = useState<ThemeTemplateId>(initialTemplate ?? "default");
  const [resolved, setResolved] = useState<"dark" | "light">(initialTheme === "light" ? "light" : "dark");

  useEffect(() => {
    const storedTheme = localStorage.getItem(KEY);
    const storedTemplate = localStorage.getItem(TEMPLATE_KEY);
    const nextTheme = initialTheme ?? (isThemeMode(storedTheme) ? storedTheme : "dark");
    const nextTemplate = initialTemplate ?? (isThemeTemplateId(storedTemplate) ? storedTemplate : "default");
    setThemeState(nextTheme);
    setTemplateState(nextTemplate);
    setResolved(resolveTheme(nextTheme));
  }, [initialTheme, initialTemplate]);

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
    applyDom(resolved, template);
  }, [resolved, template]);

  const value = useMemo<ThemeCtx>(
    () => ({
      theme,
      template,
      resolved,
      setTheme: (t) => {
        localStorage.setItem(KEY, t);
        setThemeState(t);
        setResolved(resolveTheme(t));
        if (persistAccount) void rpc("theme_update", { theme: t }).catch(() => {});
      },
      setTemplate: (t) => {
        localStorage.setItem(TEMPLATE_KEY, t);
        setTemplateState(t);
        if (persistAccount) void rpc("theme_update", { theme_template: t }).catch(() => {});
      },
    }),
    [theme, template, resolved, persistAccount],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}

const ORDER: Theme[] = ["dark", "light", "system"];
const LABELS: Record<Theme, string> = { dark: "Dark", light: "Light", system: "System" };

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABELS[theme]}. Switch to ${LABELS[next]}.`}
      title={`Theme: ${LABELS[theme]} — click to switch to ${LABELS[next]}`}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-sm font-medium text-ink-2 transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-2 hover:text-ink"
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
      {!compact ? LABELS[theme] : null}
    </button>
  );
}
