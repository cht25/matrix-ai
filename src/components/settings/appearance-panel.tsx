"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
import { ThemeGallery } from "@/components/theme-gallery";
import { Card } from "@/components/ui";
import { applyRainSetting, readRainSetting, type RainSetting } from "@/components/matrix-rain";
import { cn } from "@/lib/utils";

// Light first: it is the primary MATRIX theme. Dark is the alternative;
// System follows the device preference.
const OPTIONS: { id: Theme; label: string; desc: string; icon: typeof Moon }[] = [
  { id: "light", label: "Light", desc: "Soft paper with blue-gray layers — the default", icon: Sun },
  { id: "dark", label: "Dark", desc: "Deep navy — easy on the eyes", icon: Moon },
  { id: "system", label: "System", desc: "Follow your device setting", icon: Monitor },
];

const RAIN_OPTIONS: { id: RainSetting; label: string; desc: string }[] = [
  { id: "off", label: "Off", desc: "No animation — flattest, fastest" },
  { id: "subtle", label: "Subtle", desc: "Slow, faint rain" },
  { id: "normal", label: "Normal", desc: "The classic MATRIX rain" },
  { id: "heavy", label: "Heavy", desc: "Denser, faster — showcase mode" },
];

export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const [rain, setRain] = useState<RainSetting>("normal");
  useEffect(() => { setRain(readRainSetting()); }, []);
  function chooseRain(next: RainSetting) {
    setRain(next);
    applyRainSetting(next);
  }
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-bold text-ink">MATRIX background</h2>
        <p className="mt-1 text-sm text-ink-2">
          The digital rain plays behind every page of MATRIX across both dark and light themes. It pauses automatically
          when the tab is hidden and scales down on compact screens to save battery.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="MATRIX background intensity">
          {RAIN_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={rain === option.id}
              onClick={() => chooseRain(option.id)}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors",
                rain === option.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
              )}
            >
              <span className="block text-sm font-semibold text-ink">{option.label}</span>
              <span className="mt-1 block text-[11px] leading-relaxed text-ink-3">{option.desc}</span>
            </button>
          ))}
        </div>
      </Card>
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
