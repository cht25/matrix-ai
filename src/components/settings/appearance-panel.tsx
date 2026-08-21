"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
import { ThemeGallery } from "@/components/theme-gallery";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

// Light first: it is the primary MATRIX theme. Dark is the alternative;
// System follows the device preference.
const OPTIONS: { id: Theme; label: string; desc: string; icon: typeof Moon }[] = [
  { id: "light", label: "Light", desc: "Soft paper with blue-gray layers — the default", icon: Sun },
  { id: "dark", label: "Dark", desc: "Deep navy — easy on the eyes", icon: Moon },
  { id: "system", label: "System", desc: "Follow your device setting", icon: Monitor },
];

export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-bold text-ink">Appearance</h2>
        <p className="mt-1 text-sm text-ink-2">Dark, light and system stay first-class. Templates only change your account.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
          {OPTIONS.map((o) => {
            const Icon = o.icon;
            return (
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
                <Icon size={18} className="text-ink-2" />
                <span>
                  <span className="block font-bold text-ink">{o.label}</span>
                  <span className="block text-xs text-ink-3">{o.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Card>
      <Card>
        <h2 className="font-bold text-ink">Theme templates</h2>
        <p className="mt-1 text-sm text-ink-2">Professionally designed palettes. Applying one never changes anyone else's MATRIX.</p>
        <div className="mt-4">
          <ThemeGallery />
        </div>
      </Card>
    </div>
  );
}
