"use client";

// MATRIX application shell — professional security workspace.
// Desktop: sectioned sidebar (Workspace · Intelligence · Learning · Account).
// Mobile: top bar + slide-in drawer + bottom navigation.
// Monochromatic icons throughout; no emoji in navigation.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Award, BookOpen, FileSearch, GraduationCap, History, LayoutGrid, Menu, MessageSquare,
  Plus, Search, Settings, Shield, ShieldAlert, User, X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/browser";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/lib/theme";
import { ToastProvider } from "@/components/toast";
import { SignOutButton } from "@/components/sign-out-button";
import { groupConversations, groupLabel, formatTime, type SidebarConversation } from "@/lib/chat-utils";
import { cn } from "@/lib/utils";

const NAV_SECTIONS: { label: string; items: { href: string; label: string; icon: ReactNode }[] }[] = [
  {
    label: "Workspace",
    items: [
      { href: "/chat", label: "New conversation", icon: <MessageSquare size={15} strokeWidth={1.6} /> },
      { href: "/history", label: "History", icon: <History size={15} strokeWidth={1.6} /> },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/scanner", label: "Scanner", icon: <FileSearch size={15} strokeWidth={1.6} /> },
      { href: "/scams", label: "Scam Intelligence", icon: <ShieldAlert size={15} strokeWidth={1.6} /> },
      { href: "/report", label: "Report", icon: <Shield size={15} strokeWidth={1.6} /> },
      { href: "/emergency", label: "Emergency Help", icon: <ShieldAlert size={15} strokeWidth={1.6} /> },
    ],
  },
  {
    label: "Learning",
    items: [
      { href: "/courses", label: "Courses", icon: <GraduationCap size={15} strokeWidth={1.6} /> },
      { href: "/certificates", label: "Certificates", icon: <Award size={15} strokeWidth={1.6} /> },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/security", label: "Security", icon: <Shield size={15} strokeWidth={1.6} /> },
      { href: "/settings", label: "Settings", icon: <Settings size={15} strokeWidth={1.6} /> },
      { href: "/docs", label: "Documentation", icon: <BookOpen size={15} strokeWidth={1.6} /> },
    ],
  },
];

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function HistoryList({ conversations, onNavigate }: { conversations: SidebarConversation[]; onNavigate?: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(needle) || c.summary.toLowerCase().includes(needle));
  }, [q, conversations]);

  const groups = useMemo(() => groupConversations(filtered), [filtered]);
  const groupKeys = (Object.keys(groups) as (keyof typeof groups)[]).filter((k) => groups[k].length > 0);

  async function rename(id: string) {
    const supabase = createClient();
    await supabase.from("conversations").update({ title: renameValue.trim() || "Untitled" }).eq("id", id);
    setRenaming(null);
    router.refresh();
  }
  async function archive(id: string) {
    const supabase = createClient();
    await supabase.from("conversations").update({ archived_at: new Date().toISOString() }).eq("id", id);
    router.refresh();
  }
  async function remove(id: string) {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    const supabase = createClient();
    await supabase.from("conversations").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    router.refresh();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mb-3">
        <Search size={13} strokeWidth={1.6} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="input-base !rounded-md !py-1.5 pl-8 text-[13px]"
        />
      </div>
      <nav className="no-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto pr-0.5" aria-label="Conversation history">
        {groupKeys.length === 0 ? (
          <p className="px-1 text-xs text-ink-3">No conversations yet.</p>
        ) : (
          groupKeys.map((k) => (
            <div key={k}>
              <p className="eyebrow px-1 pb-1.5">{groupLabel(k)}</p>
              <ul className="space-y-px">
                {groups[k].map((c) => (
                  <li key={c.id} className="group relative">
                    <Link
                      href={`/chat/${c.id}`}
                      onClick={onNavigate}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <span className="min-w-0 truncate">{c.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
                        {formatTime(c.updated_at)}
                      </span>
                    </Link>
                    <div className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 group-hover:block">
                      <details className="relative">
                        <summary className="grid h-6 w-6 cursor-pointer list-none place-items-center rounded bg-surface text-ink-3 shadow-sm [&::-webkit-details-marker]:hidden">
                          ⋯
                        </summary>
                        <div className="card absolute right-0 z-30 mt-1 w-36 !rounded-lg !p-1 text-xs shadow-[var(--shadow-pop)]">
                          {renaming === c.id ? (
                            <div className="space-y-1 p-1">
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") void rename(c.id); }}
                                className="input-base !py-1 text-xs"
                                aria-label="New title"
                              />
                              <button onClick={() => void rename(c.id)} className="w-full rounded bg-ink px-2 py-1 text-white">Save</button>
                            </div>
                          ) : (
                            <>
                              <button onClick={() => { setRenaming(c.id); setRenameValue(c.title); }} className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-surface-2">Rename</button>
                              <button onClick={() => void archive(c.id)} className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-surface-2">Archive</button>
                              <button onClick={() => void remove(c.id)} className="block w-full rounded px-2 py-1.5 text-left text-danger hover:bg-danger-soft">Delete</button>
                            </>
                          )}
                        </div>
                      </details>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>
    </div>
  );
}

function SidebarBody({
  conversations,
  isAdmin,
  onNavigate,
  footer,
}: {
  conversations: SidebarConversation[];
  isAdmin: boolean;
  onNavigate?: () => void;
  footer?: ReactNode;
}) {
  const pathname = usePathname();
  const isChat = (href: string) =>
    href === "/chat" ? pathname === "/chat" || pathname.startsWith("/chat/") : pathname === href || pathname.startsWith(href + "/");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-4 pt-5">
        <Logo size="sm" href="/chat" />
      </div>
      <div className="px-3 pb-4">
        <Link
          href="/chat"
          onClick={onNavigate}
          className={cn(
            "flex min-h-9 items-center justify-center gap-2 rounded-md border text-[13px] font-medium transition-colors",
            pathname === "/chat" || pathname.startsWith("/chat/")
              ? "border-border-strong bg-surface-2 text-ink"
              : "border-border-strong bg-surface text-ink hover:border-accent hover:text-accent",
          )}
        >
          <Plus size={14} strokeWidth={1.6} aria-hidden="true" /> New conversation
        </Link>
      </div>
      <div className="min-h-0 flex-1 px-3">
        <HistoryList conversations={conversations} onNavigate={onNavigate} />
      </div>
      <nav className="border-t border-border px-3 py-3" aria-label="Main navigation">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="mb-3 last:mb-0">
            <p className="eyebrow px-2 pb-1.5">{section.label}</p>
            <ul className="space-y-px">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex min-h-8 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                      isChat(item.href)
                        ? "bg-surface-2 font-medium text-ink"
                        : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    <span className="text-ink-3" aria-hidden="true">{item.icon}</span>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {isAdmin ? (
          <div className="mb-3">
            <p className="eyebrow px-2 pb-1.5">Administration</p>
            <Link href="/admin" onClick={onNavigate} className="flex min-h-8 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
              <span className="text-ink-3"><LayoutGrid size={15} strokeWidth={1.6} /></span>
              Admin Panel
            </Link>
          </div>
        ) : null}
      </nav>
      {footer}
    </div>
  );
}

function ProfileMenu({ user, onNavigate }: { user: { email: string; fullName: string } | null; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative border-t border-border p-3">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-2 text-xs font-semibold text-ink">
          {(user?.fullName || user?.email || "U").slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{user?.fullName || "User"}</span>
          <span className="block truncate text-[11px] text-ink-3">{user?.email}</span>
        </span>
      </button>
      {open ? (
        <>
          <button className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="card fade-in absolute bottom-full left-3 z-30 mb-1 w-56 !rounded-lg !p-1.5 shadow-[var(--shadow-pop)]">
            {[
              { label: "Security", href: "/security" },
              { label: "Settings", href: "/settings" },
              { label: "Documentation", href: "/docs" },
              { label: "Help", href: "/support" },
            ].map((it) => (
              <Link
                key={it.href}
                href={it.href}
                onClick={() => { setOpen(false); onNavigate?.(); }}
                className="block rounded-md px-3 py-2 text-sm text-ink transition-colors hover:bg-surface-2"
              >
                {it.label}
              </Link>
            ))}
            <div className="my-1 border-t border-border" />
            <SignOutButton label="Logout" />
          </div>
        </>
      ) : null}
    </div>
  );
}

export function AppShell({
  user,
  conversations,
  isAdmin,
  children,
}: {
  user: { email: string; fullName: string } | null;
  conversations: SidebarConversation[];
  isAdmin: boolean;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const online = useOnline();
  const pathname = usePathname();

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <ToastProvider>
      <div className="min-h-dvh lg:flex">
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-border bg-surface/85 backdrop-blur-xl lg:block">
          <SidebarBody
            conversations={conversations}
            isAdmin={isAdmin}
            footer={
              <div className="flex items-center gap-2 px-3 pb-3">
                <ThemeToggle compact />
                <ProfileMenu user={user} />
              </div>
            }
          />
        </aside>

        {/* Mobile drawer */}
        {drawerOpen ? (
          <>
            <button
              className="fade-in fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
            />
            <aside className="drawer-in fixed inset-y-0 left-0 z-50 w-[85vw] max-w-sm border-r border-border bg-surface lg:hidden">
              <div className="flex items-center justify-between px-4 pt-4">
                <Logo size="sm" href="/chat" />
                <button onClick={() => setDrawerOpen(false)} aria-label="Close menu" className="grid h-9 w-9 place-items-center rounded-md text-ink-2 hover:bg-surface-2">
                  <X size={16} strokeWidth={1.6} />
                </button>
              </div>
              <SidebarBody
                conversations={conversations}
                isAdmin={isAdmin}
                onNavigate={() => setDrawerOpen(false)}
                footer={
                  <div className="flex items-center gap-2 px-3 pb-3">
                    <ThemeToggle compact />
                    <ProfileMenu user={user} onNavigate={() => setDrawerOpen(false)} />
                  </div>
                }
              />
            </aside>
          </>
        ) : null}

        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex h-13 items-center justify-between gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="grid h-10 w-10 place-items-center rounded-md text-ink-2 hover:bg-surface-2"
            >
              <Menu size={18} strokeWidth={1.6} />
            </button>
            <Logo size="sm" href="/chat" />
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/temporary-chat"
              aria-label="Temporary chat"
              className={cn(
                "grid h-10 w-10 place-items-center rounded-md",
                pathname.startsWith("/temporary-chat") ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2",
              )}
            >
              <History size={16} strokeWidth={1.6} />
            </Link>
            <Link
              href="/chat"
              aria-label="New conversation"
              className="grid h-10 w-10 place-items-center rounded-md text-ink-2 hover:bg-surface-2"
            >
              <Plus size={16} strokeWidth={1.6} />
            </Link>
          </div>
        </header>

        {/* Offline banner */}
        {!online ? (
          <div className="fixed inset-x-0 top-14 z-[60] border-b border-danger/40 bg-danger-soft px-4 py-2 text-center text-sm font-medium text-danger lg:top-0" role="alert">
            You're offline — reconnecting…
          </div>
        ) : null}

        {/* Content */}
        <div className="min-w-0 flex-1 pb-16 lg:pb-0 lg:pl-64">
          <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6 lg:py-7">{children}</div>
        </div>

        {/* Mobile bottom navigation */}
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/92 backdrop-blur-xl lg:hidden" aria-label="Bottom navigation">
          <div className="mx-auto grid max-w-md grid-cols-5">
            {[
              { href: "/chat", label: "Workspace", icon: <MessageSquare size={17} strokeWidth={1.6} /> },
              { href: "/history", label: "History", icon: <History size={17} strokeWidth={1.6} /> },
              { href: "/scanner", label: "Scanner", icon: <FileSearch size={17} strokeWidth={1.6} /> },
              { href: "/courses", label: "Learning", icon: <GraduationCap size={17} strokeWidth={1.6} /> },
              { href: "/settings", label: "Profile", icon: <User size={17} strokeWidth={1.6} /> },
            ].map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "flex min-h-13 flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors",
                  pathname === n.href || (n.href === "/chat" && pathname.startsWith("/chat/"))
                    ? "text-ink"
                    : "text-ink-3 hover:text-ink",
                )}
              >
                <span className="text-ink-3" aria-hidden="true">{n.icon}</span>
                {n.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </ToastProvider>
  );
}
