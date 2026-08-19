"use client";

import { useTheme, type Theme } from "@/lib/theme";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

const OPTIONS: { id: Theme; label: string; icon: string; desc: string }[] = [
  { id: "dark", label: "Dark", icon: "🌙", desc: "Black cyber environment — default" },
  { id: "light", label: "Light", icon: "☀️", desc: "Bright and clean" },
  { id: "system", label: "System", icon: "🖥️", desc: "Follow your device setting" },
];

export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  return (
    <Card>
      <h2 className="font-bold text-ink">Appearance</h2>
      <p className="mt-1 text-sm text-ink-2">The animated background adapts to both themes. Reduced-motion is respected automatically.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={theme === o.id}
            onClick={() => setTheme(o.id)}
            className={cn(
              "card card-hover flex min-h-28 flex-col items-start justify-between !p-4 text-left",
              theme === o.id && "!border-accent ring-2 ring-accent/40",
            )}
          >
            <span className="text-2xl" aria-hidden="true">{o.icon}</span>
            <span>
              <span className="block font-bold text-ink">{o.label}</span>
              <span className="block text-xs text-ink-3">{o.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}
