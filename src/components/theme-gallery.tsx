"use client";

import { THEME_TEMPLATES, type ThemeTemplateId } from "@/lib/theme-templates";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";

export function ThemeGallery({ compact = false }: { compact?: boolean }) {
  const { template, resolved, setTemplate } = useTheme();

  return (
    <div className="space-y-3">
      <div className={cn("grid gap-3", compact ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3")}>
        {THEME_TEMPLATES.map((item) => {
          const swatch = resolved === "light" ? item.light : item.dark;
          const active = template === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTemplate(item.id)}
              className={cn(
                "card card-hover flex min-h-32 flex-col items-stretch gap-3 !p-3 text-left",
                active && "!border-accent ring-2 ring-accent/40",
              )}
              aria-pressed={active}
            >
              <span className="flex h-10 overflow-hidden rounded-md border border-border">
                {[swatch.bg, swatch.surface, swatch.ink, swatch.accent].map((color) => (
                  <span key={color} className="flex-1" style={{ background: color }} />
                ))}
              </span>
              <span>
                <span className="block text-sm font-semibold text-ink">{item.name}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{item.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <Button type="button" variant="outline" onClick={() => setTemplate("default" as ThemeTemplateId)}>
        Reset to MATRIX default
      </Button>
    </div>
  );
}
