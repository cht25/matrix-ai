"use client";

import Link from "next/link";

export function AdminTabs({ tabs, active, codes }: { tabs: { id: string; label: string }[]; active: string; codes: Set<string> }) {
  return (
    <nav aria-label="Admin sections" className="no-scrollbar flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={`/admin?tab=${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={`whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold ${
            active === t.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {t.label}
        </Link>
      ))}
      {codes.size === 0 ? <span className="self-center px-3 text-xs font-semibold text-amber-600">Read-only (no admin role)</span> : null}
    </nav>
  );
}
