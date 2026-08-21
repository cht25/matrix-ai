"use client";

import Link from "next/link";

export function SettingsTabs({ tabs, active }: { tabs: { id: string; label: string }[]; active: string }) {
  return (
    <nav aria-label="Settings tabs" className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={`/settings?tab=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={`min-h-11 shrink-0 whitespace-nowrap rounded-[10px] px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
            active === t.id ? "bg-accent text-white" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
