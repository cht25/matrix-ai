"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
import { ThemeGallery } from "@/components/theme-gallery";
import { Card } from "@/components/ui";
import { applyAmbientSetting, readAmbientSetting, type AmbientSetting } from "@/lib/ambient";
import { cn } from "@/lib/utils";

// Dark is the primary QORVYNA theme (the identity is drawn on deep navy);
// light is a fully designed alternative and System follows the device.
const OPTIONS: { id: Theme; label: string; desc: string; icon: typeof Moon }[] = [
  { id: "dark", label: "Dark", desc: "Deep navy — the default", icon: Moon },
  { id: "light", label: "Light", desc: "Cool paper white with navy ink", icon: Sun },
  { id: "system", label: "System", desc: "Follow your device setting", icon: Monitor },
];

const AMBIENT_OPTIONS: { id: AmbientSetting; label: string; desc: string }[] = [
  { id: "off", label: "Off", desc: "Flat background" },
  { id: "subtle", label: "Subtle", desc: "A faint hint of colour" },
  { id: "normal", label: "Normal", desc: "The standard brand glow" },
  { id: "heavy", label: "Vivid", desc: "Full-strength colour" },
];

export function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const [ambient, setAmbient] = useState<AmbientSetting>("normal");
  useEffect(() => { setAmbient(readAmbientSetting()); }, []);
  function chooseAmbient(next: AmbientSetting) {
    setAmbient(next);
    applyAmbientSetting(next);
  }
  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-bold text-ink">Background glow</h2>
        <p className="mt-1 text-sm text-ink-2">
          A soft blue and violet glow sits behind every page. It is a still image, not an animation, so it costs no
          battery and never slows scrolling.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Background glow strength">
          {AMBIENT_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={ambient === option.id}
              onClick={() => chooseAmbient(option.id)}
              className={cn(
                "min-h-11 rounded-xl border p-3 text-left transition-colors",
                ambient === option.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
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
        <p className="mt-1 text-sm text-ink-2">Professionally designed palettes. Applying one never changes anyone else's QORVYNA.</p>
        <div className="mt-4">
          <ThemeGallery />
        </div>
      </Card>
    </div>
  );
}
