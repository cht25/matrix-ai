"use client";

import Link from "next/link";

export function SettingsTabs({ tabs, active }: { tabs: { id: string; label: string }[]; active: string }) {
  return (
    <nav aria-label="Settings tabs" className="no-scrollbar flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={`/settings?tab=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={`min-h-10 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            active === t.id ? "bg-ink text-bg" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
