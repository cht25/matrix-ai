"use client";

// MATRIX application shell:
//  - Desktop (lg+): persistent sidebar (logo, new chat, search, grouped
//    history, nav, profile menu).
//  - Mobile: top bar + slide-in drawer + bottom navigation bar.
//  - Offline banner, toast host, theme toggle.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/lib/theme";
import { ToastProvider } from "@/components/toast";
import { SignOutButton } from "@/components/sign-out-button";
import { groupConversations, groupLabel, formatTime, type SidebarConversation } from "@/lib/chat-utils";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/chat", label: "Chat", icon: "💬" },
  { href: "/temporary-chat", label: "Temporary Chat", icon: "🕒" },
  { href: "/scanner", label: "Scanner", icon: "🔍" },
  { href: "/scams", label: "Scam Library", icon: "🛡️" },
  { href: "/courses", label: "Courses", icon: "🎓" },
  { href: "/certificates", label: "Certificates", icon: "🏅" },
  { href: "/security", label: "Security", icon: "🔐" },
  { href: "/docs", label: "Documentation", icon: "📘" },
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

function HistoryList({
  conversations,
  onNavigate,
}: {
  conversations: SidebarConversation[];
  onNavigate?: () => void;
}) {
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
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search conversations…"
        aria-label="Search conversations"
        className="input-base mb-2 !py-2 text-sm"
      />
      <nav className="no-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5" aria-label="Conversation history">
        {groupKeys.length === 0 ? (
          <p className="px-1 text-xs text-ink-3">No conversations yet.</p>
        ) : (
          groupKeys.map((k) => (
            <div key={k}>
              <p className="px-1 pb-1 text-[10px] font-bold uppercase tracking-widest text-ink-3">{groupLabel(k)}</p>
              <ul className="space-y-0.5">
                {groups[k].map((c) => (
                  <li key={c.id} className="group relative">
                    <Link
                      href={`/chat/${c.id}`}
                      onClick={onNavigate}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <span className="min-w-0 truncate">{c.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
                        {formatTime(c.updated_at)}
                      </span>
                    </Link>
                    <div className="absolute right-1 top-1/2 z-10 hidden -translate-y-1/2 group-hover:block">
                      <details className="relative">
                        <summary className="grid h-7 w-7 cursor-pointer list-none place-items-center rounded-md bg-surface text-ink-3 shadow-sm [&::-webkit-details-marker]:hidden">
                          ⋯
                        </summary>
                        <div className="card absolute right-0 z-30 mt-1 w-36 !rounded-xl !p-1 text-xs shadow-[var(--shadow-pop)]">
                          {renaming === c.id ? (
                            <div className="space-y-1 p-1">
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") void rename(c.id); }}
                                className="input-base !py-1.5 text-xs"
                                aria-label="New title"
                              />
                              <button onClick={() => void rename(c.id)} className="w-full rounded-md bg-accent px-2 py-1 text-white">Save</button>
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => { setRenaming(c.id); setRenameValue(c.title); }}
                                className="block w-full rounded-md px-2 py-1.5 text-left text-ink hover:bg-surface-2"
                              >
                                Rename
                              </button>
                              <button onClick={() => void archive(c.id)} className="block w-full rounded-md px-2 py-1.5 text-left text-ink hover:bg-surface-2">
                                Archive
                              </button>
                              <button onClick={() => void remove(c.id)} className="block w-full rounded-md px-2 py-1.5 text-left text-danger hover:bg-danger-soft">
                                Delete
                              </button>
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <Logo size="sm" href="/chat" />
      </div>
      <div className="px-3 pb-3">
        <Link
          href="/chat"
          onClick={onNavigate}
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent font-semibold text-white shadow-[0_4px_16px_var(--accent-glow)] transition-all hover:brightness-110"
        >
          + New Chat
        </Link>
      </div>
      <div className="min-h-0 flex-1 px-3">
        <HistoryList conversations={conversations} onNavigate={onNavigate} />
      </div>
      <nav className="border-t border-border px-3 py-3" aria-label="Main navigation">
        <ul className="space-y-0.5">
          {NAV.map((n) => (
            <li key={n.href}>
              <Link
                href={n.href}
                onClick={onNavigate}
                className={cn(
                  "flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors",
                  pathname === n.href || (n.href === "/chat" && pathname.startsWith("/chat/"))
                    ? "bg-accent-soft text-accent"
                    : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )}
              >
                <span aria-hidden="true">{n.icon}</span>
                {n.label}
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/settings"
              onClick={onNavigate}
              className={cn(
                "flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors",
                pathname.startsWith("/settings") ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <span aria-hidden="true">⚙️</span>
              Settings
            </Link>
          </li>
          {isAdmin ? (
            <li>
              <Link
                href="/admin"
                onClick={onNavigate}
                className="flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <span aria-hidden="true">🛠️</span>
                Admin
              </Link>
            </li>
          ) : null}
        </ul>
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
        className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-2 text-sm font-bold text-white">
          {(user?.fullName || user?.email || "U").slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{user?.fullName || "User"}</span>
          <span className="block truncate text-xs text-ink-3">{user?.email}</span>
        </span>
        <span className="text-xs text-ink-3" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <>
          <button className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="card fade-in absolute bottom-full left-3 z-30 mb-1 w-56 !rounded-xl !p-1.5 shadow-[var(--shadow-pop)]">
            {[
              { label: "Security overview", href: "/security" },
              { label: "Settings", href: "/settings" },
              { label: "Documentation", href: "/docs" },
              { label: "Help", href: "/support" },
            ].map((it) => (
              <Link
                key={it.href}
                href={it.href}
                onClick={() => { setOpen(false); onNavigate?.(); }}
                className="block rounded-lg px-3 py-2 text-sm text-ink transition-colors hover:bg-surface-2"
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
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 border-r border-border bg-surface/80 backdrop-blur-xl lg:block">
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
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="grid h-11 w-11 place-items-center rounded-xl text-ink-2 hover:bg-surface-2"
            >
              ☰
            </button>
            <Logo size="sm" href="/chat" showWordmark={false} />
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/temporary-chat"
              aria-label="Temporary chat"
              className={cn(
                "grid h-11 w-11 place-items-center rounded-xl text-lg",
                pathname.startsWith("/temporary-chat") ? "bg-warning-soft" : "text-ink-2 hover:bg-surface-2",
              )}
            >
              🕒
            </Link>
            <Link
              href="/chat"
              aria-label="New chat"
              className="grid h-11 w-11 place-items-center rounded-xl text-ink-2 hover:bg-surface-2"
            >
              ＋
            </Link>
          </div>
        </header>

        {/* Offline banner */}
        {!online ? (
          <div className="fixed inset-x-0 top-14 z-[60] bg-danger px-4 py-2 text-center text-sm font-semibold text-white lg:top-0" role="alert">
            You're offline — reconnecting…
          </div>
        ) : null}

        {/* Content */}
        <div className="min-w-0 flex-1 pb-20 lg:pb-0 lg:pl-72">
          <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6 lg:py-6">{children}</div>
        </div>

        {/* Mobile bottom navigation */}
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/90 backdrop-blur-xl lg:hidden" aria-label="Bottom navigation">
          <div className="mx-auto grid max-w-md grid-cols-5">
            {[
              { href: "/chat", label: "Home", icon: "🏠" },
              { href: "/history", label: "Chats", icon: "🗂️" },
              { href: "/scanner", label: "Scanner", icon: "🔍" },
              { href: "/courses", label: "Courses", icon: "🎓" },
              { href: "/settings", label: "Profile", icon: "👤" },
            ].map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition-colors",
                  pathname === n.href || (n.href === "/chat" && pathname.startsWith("/chat/"))
                    ? "text-accent"
                    : "text-ink-3 hover:text-ink",
                )}
              >
                <span className="text-lg" aria-hidden="true">{n.icon}</span>
                {n.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </ToastProvider>
  );
}
