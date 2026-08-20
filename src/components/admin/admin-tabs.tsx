"use client";

import Link from "next/link";

export function AdminTabs({ tabs, active, codes }: { tabs: { id: string; label: string }[]; active: string; codes: string[] }) {
  return (
    <nav aria-label="Admin sections" className="no-scrollbar flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={`/admin?tab=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={`whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold ${
            active === t.id ? "bg-ink text-white" : "text-ink-2 hover:bg-surface-2"
          }`}
        >
          {t.label}
        </Link>
      ))}
      {codes.length === 0 ? <span className="self-center px-3 text-xs font-semibold text-warning">Read-only (no admin role)</span> : null}
    </nav>
  );
}
