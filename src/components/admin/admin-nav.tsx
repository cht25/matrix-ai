"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/verification", label: "Age verification" },
  { href: "/admin/consents", label: "Consents" },
  { href: "/admin/reports", label: "Scam reports" },
  { href: "/admin/courses", label: "Courses" },
  { href: "/admin/scams", label: "Scam library" },
  { href: "/admin/security", label: "Security" },
  { href: "/admin/ai", label: "AI usage" },
  { href: "/admin/audit-logs", label: "Audit logs" },
  { href: "/admin/sites", label: "Published sites" },
  { href: "/admin/setup", label: "Setup" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="no-scrollbar flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1">
      {SECTIONS.map((s) => {
        const active = s.exact ? pathname === s.href : pathname.startsWith(s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "min-h-10 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors",
              active ? "bg-ink text-bg" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
