"use client";

// MATRIX mobile navigation — a fixed bottom bar plus a "More" bottom sheet.
// There is deliberately NO hamburger menu: the four primary destinations are
// always one tap away and every secondary feature lives in More.

import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity, BookOpen, Code2, FileSearch, GraduationCap, HeartPulse, History, KeyRound,
  LayoutGrid, LifeBuoy, MessageSquare, MoreHorizontal, Rocket, Settings, Shield,
  ShieldAlert, Sliders, User,
} from "lucide-react";
import { BottomSheet } from "@/components/bottom-sheet";
import { ThemeToggle } from "@/lib/theme";
import { SignOutButton } from "@/components/sign-out-button";
import { cn } from "@/lib/utils";

export type MoreLink = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Section heading this entry belongs to. */
  group: string;
};

/**
 * Build the More menu for the current user. Entries the user cannot access
 * are never rendered — the pages themselves re-check authorization server-side.
 */
export function buildMoreLinks({ isAdmin }: { isAdmin: boolean }): MoreLink[] {
  const links: MoreLink[] = [
    { href: "/dashboard", label: "Dashboard", icon: <LayoutGrid size={18} strokeWidth={1.7} />, group: "Workspace" },
    { href: "/projects", label: "Projects", icon: <Code2 size={18} strokeWidth={1.7} />, group: "Workspace" },
    { href: "/history", label: "History", icon: <History size={18} strokeWidth={1.7} />, group: "Workspace" },

    { href: "/courses", label: "Courses", icon: <GraduationCap size={18} strokeWidth={1.7} />, group: "Learn" },
    { href: "/certificates", label: "Certificates", icon: <BookOpen size={18} strokeWidth={1.7} />, group: "Learn" },

    { href: "/scanner", label: "Scanner", icon: <FileSearch size={18} strokeWidth={1.7} />, group: "Safety" },
    { href: "/scams", label: "Scam library", icon: <ShieldAlert size={18} strokeWidth={1.7} />, group: "Safety" },
    { href: "/report", label: "Report a scam", icon: <Shield size={18} strokeWidth={1.7} />, group: "Safety" },
    { href: "/security", label: "Security", icon: <Activity size={18} strokeWidth={1.7} />, group: "Safety" },
    { href: "/emergency", label: "Emergency help", icon: <HeartPulse size={18} strokeWidth={1.7} />, group: "Safety" },

    { href: "/settings", label: "Settings", icon: <Settings size={18} strokeWidth={1.7} />, group: "Account" },
    { href: "/settings?tab=account", label: "Edit profile", icon: <User size={18} strokeWidth={1.7} />, group: "Account" },
    { href: "/docs", label: "Documentation", icon: <BookOpen size={18} strokeWidth={1.7} />, group: "Account" },
    { href: "/support", label: "Help & support", icon: <LifeBuoy size={18} strokeWidth={1.7} />, group: "Account" },
  ];

  if (isAdmin) {
    links.push(
      { href: "/admin", label: "Admin overview", icon: <Sliders size={18} strokeWidth={1.7} />, group: "Admin" },
      { href: "/admin/ai", label: "AI configuration", icon: <KeyRound size={18} strokeWidth={1.7} />, group: "Admin" },
      { href: "/admin/sites", label: "Deployments", icon: <Rocket size={18} strokeWidth={1.7} />, group: "Admin" },
      { href: "/admin/security", label: "Security centre", icon: <ShieldAlert size={18} strokeWidth={1.7} />, group: "Admin" },
    );
  }
  return links;
}

const PRIMARY = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/chat?mode=agent", label: "Agent", icon: Code2 },
  { href: "/workspace", label: "Workspace", icon: LayoutGrid },
  { href: "/temporary-chat", label: "Private", icon: History },
] as const;

function MobileNavImpl({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [moreOpen, setMoreOpen] = useState(false);
  const agentActive = pathname === "/chat" && searchParams.get("mode") === "agent";

  const links = useMemo(() => buildMoreLinks({ isAdmin }), [isAdmin]);
  const groups = useMemo(() => {
    const map = new Map<string, MoreLink[]>();
    for (const link of links) {
      const bucket = map.get(link.group) ?? [];
      bucket.push(link);
      map.set(link.group, bucket);
    }
    return [...map.entries()];
  }, [links]);

  function isActive(href: string): boolean {
    if (href === "/chat?mode=agent") return agentActive;
    if (href === "/chat") return (pathname === "/chat" || pathname.startsWith("/chat/")) && !agentActive;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const moreActive = links.some((l) => !l.href.includes("?") && pathname.startsWith(l.href) && l.href !== "/");

  return (
    <>
      <nav className="bottom-nav" aria-label="Primary">
        {PRIMARY.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn("bottom-nav-item", active && "is-active")}
            >
              <span className="bottom-nav-icon" aria-hidden="true">
                <Icon size={19} strokeWidth={1.7} />
              </span>
              <span>{label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cn("bottom-nav-item", (moreOpen || moreActive) && "is-active")}
        >
          <span className="bottom-nav-icon" aria-hidden="true">
            <MoreHorizontal size={19} strokeWidth={1.7} />
          </span>
          <span>More</span>
        </button>
      </nav>

      <BottomSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="More"
        footer={
          <div className="space-y-1">
            <ThemeToggle />
            <SignOutButton label="Sign out" />
          </div>
        }
      >
        {groups.map(([group, items]) => (
          <section key={group}>
            <p className="eyebrow sheet-section-title">{group}</p>
            <ul>
              {items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className="sheet-item"
                    data-active={pathname === item.href.split("?")[0] ? "true" : undefined}
                  >
                    <span className="sheet-item-icon" aria-hidden="true">{item.icon}</span>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </BottomSheet>
    </>
  );
}

export const MobileNav = memo(MobileNavImpl);
