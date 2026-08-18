"use client";

import Link from "next/link";

export function SettingsTabs({ tabs, active }: { tabs: { id: string; label: string }[]; active: string }) {
  return (
    <nav aria-label="Settings tabs" className="no-scrollbar flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={`/settings?tab=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold ${
            active === t.id ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
