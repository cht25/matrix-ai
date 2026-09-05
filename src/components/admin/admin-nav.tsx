"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity, BookOpen, Cpu, Globe, LayoutDashboard, LibraryBig,
  ScrollText, ShieldAlert, ShieldCheck, Sliders, UserCheck, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Section = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
  /** Permission required to see this entry (undefined = always visible). */
  permission?: string;
};

const GROUPS: { title: string; items: Section[] }[] = [
  {
    title: "Operations",
    items: [
      { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
      { href: "/admin/users", label: "Users", icon: Users, permission: "users.view" },
      { href: "/admin/verification", label: "Age verification", icon: UserCheck, permission: "verification.review" },
      { href: "/admin/consents", label: "Consents", icon: ShieldCheck, permission: "consent.review" },
      { href: "/admin/reports", label: "Scam reports", icon: ShieldAlert, permission: "reports.view" },
    ],
  },
  {
    title: "Content",
    items: [
      { href: "/admin/courses", label: "Courses", icon: BookOpen, permission: "content.manage" },
      { href: "/admin/scams", label: "Scam library", icon: LibraryBig, permission: "content.manage" },
      { href: "/admin/sites", label: "Published sites", icon: Globe, permission: "content.manage" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/admin/security", label: "Security", icon: ShieldAlert, permission: "security.view" },
      { href: "/admin/ai", label: "AI configuration", icon: Cpu, permission: "ai.view" },
      { href: "/admin/audit-logs", label: "Audit logs", icon: ScrollText, permission: "audit.view" },
      { href: "/admin/setup", label: "Setup", icon: Sliders },
    ],
  },
];

function isActive(pathname: string, s: Section) {
  return s.exact ? pathname === s.href : pathname === s.href || pathname.startsWith(`${s.href}/`);
}

/**
 * Admin navigation. Renders as a sidebar rail on large screens and a
 * horizontally scrollable strip on small ones, so labels never compress or
 * overlap. Entries are filtered by the caller's real permission codes — the
 * pages themselves re-check authorization server-side.
 */
export function AdminNav({ codes = [] }: { codes?: string[] }) {
  const pathname = usePathname();
  const visible = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.permission || codes.length === 0 || codes.includes(i.permission)),
  })).filter((g) => g.items.length > 0);

  return (
    <nav aria-label="Admin sections" className="lg:sticky lg:top-4">
      {/* mobile / tablet: scrollable strip */}
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
        {visible.flatMap((g) => g.items).map((s) => {
          const active = isActive(pathname, s);
          const Icon = s.icon;
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                active
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-border bg-surface text-ink-2 hover:border-border-strong hover:text-ink",
              )}
            >
              <Icon aria-hidden className="h-4 w-4" />
              {s.label}
            </Link>
          );
        })}
      </div>

      {/* desktop: grouped rail */}
      <div className="hidden w-56 shrink-0 space-y-5 rounded-2xl border border-border bg-surface p-3 lg:block xl:w-60">
        <p className="px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">Admin</p>
        {visible.map((group) => (
          <div key={group.title} className="space-y-1">
            <p className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">{group.title}</p>
            {group.items.map((s) => {
              const active = isActive(pathname, s);
              const Icon = s.icon;
              return (
                <Link
                  key={s.href}
                  href={s.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    active
                      ? "bg-accent-soft text-accent"
                      : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  <Icon aria-hidden className="h-4 w-4 shrink-0" />
                  <span className="truncate">{s.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2">
          <Activity aria-hidden className="h-3.5 w-3.5 text-ink-3" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">Control centre</span>
        </div>
      </div>
    </nav>
  );
}

