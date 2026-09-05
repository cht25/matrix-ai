import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { SystemStatusPill } from "@/components/admin/system-status";
import { roleLabel } from "@/lib/roles";

/**
 * Shared chrome for every /admin page: compact header, permission-filtered
 * navigation rail and the content column. Keeps the whole control centre on
 * one design system instead of each page inventing its own layout.
 */
export function AdminShell({
  title,
  subtitle,
  role,
  codes,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  role?: string | null;
  codes: string[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">Matrix · Admin control centre</p>
          <h1 className="mt-1 truncate font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {role ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1 text-[11px] font-medium text-accent">
              {roleLabel(role)}
            </span>
          ) : null}
          <SystemStatusPill />
          {actions}
        </div>
      </header>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <AdminNav codes={codes} />
        <div className="min-w-0 flex-1 space-y-5">{children}</div>
      </div>
    </div>
  );
}
