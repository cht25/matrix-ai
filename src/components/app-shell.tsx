"use client";

// MATRIX application shell — compact workspace with a 276px sidebar on desktop
// and a slide-out drawer on mobile. Chat / Agent / Private stay first-class.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChevronDown, Code2, FileSearch, GraduationCap, History, LayoutGrid, Menu,
  MessageSquare, MoreVertical, Plus, Search, Shield, ShieldAlert, User, X,
} from "lucide-react";
import { rpc } from "@/lib/client/api";
import { Logo } from "@/components/logo";
import { AiStatus } from "@/components/ai-status";
import { ThemeToggle } from "@/lib/theme";
import { ToastProvider } from "@/components/toast";
import { SignOutButton } from "@/components/sign-out-button";
import { NotificationsBell } from "@/components/notifications-bell";
import { UserAvatar } from "@/components/avatar";
import { groupConversations, groupLabel, formatTime, type SidebarConversation } from "@/lib/chat-utils";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type ShellUser = { email: string; fullName: string; avatarUrl?: string };

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

function isImmersivePath(pathname: string) {
  return pathname === "/chat" || pathname.startsWith("/chat/") || pathname.startsWith("/temporary-chat") || pathname.startsWith("/projects/");
}

function NewChatButton({
  className,
  children,
  onNavigate,
  ariaLabel,
  mode = "general",
}: {
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
  ariaLabel?: string;
  mode?: "general" | "agent";
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? "New conversation"}
      onClick={() => {
        onNavigate?.();
        router.push(`/chat?mode=${mode}&new=${Date.now()}`);
      }}
      className={className}
    >
      {children}
    </button>
  );
}

function HistoryList({ conversations, onNavigate }: { conversations: SidebarConversation[]; onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
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
    await rpc("conversation_update", { id, title: renameValue.trim() || "Untitled" }).catch(() => {});
    setRenaming(null);
    setOpenId(null);
    router.refresh();
  }
  async function archive(id: string) {
    await rpc("conversation_update", { id, archive: true }).catch(() => {});
    setOpenId(null);
    if (pathname === `/chat/${id}`) router.push("/chat");
    router.refresh();
  }
  async function remove(id: string) {
    if (!confirm("Delete this conversation? This can't be undone.")) return;
    await rpc("conversation_update", { id, delete: true }).catch(() => {});
    setOpenId(null);
    if (pathname === `/chat/${id}`) router.push("/chat");
    router.refresh();
  }

  return (
    <div className="flex flex-col">
      <div className="relative mb-3">
        <Search size={14} strokeWidth={1.7} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("common.search")}
          aria-label="Search conversations"
          className="input-base !rounded-[8px] !py-2 pl-8 text-[13px]"
        />
      </div>
      <nav className="space-y-4 pr-0.5" aria-label="Conversation history">
        {groupKeys.length === 0 ? (
          <p className="px-1 text-xs text-ink-3">No conversations yet.</p>
        ) : (
          groupKeys.map((k) => (
            <div key={k}>
              <p className="eyebrow px-1 pb-1.5">{groupLabel(k)}</p>
              <ul className="space-y-0.5">
                {groups[k].map((c) => (
                  <li key={c.id} className="group relative flex min-w-0 items-center">
                    <Link
                      href={`/chat/${c.id}`}
                      onClick={onNavigate}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-[10px] py-2 pl-2 pr-1 text-[13px] transition-colors duration-150 ease-out",
                        pathname === `/chat/${c.id}` ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      {c.mode === "agent" ? <Code2 size={13} className="shrink-0 text-accent" aria-hidden="true" /> : <MessageSquare size={13} className="shrink-0 text-ink-3" aria-hidden="true" />}
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    </Link>
                    <span className="pointer-events-none mr-0.5 hidden shrink-0 text-[10px] text-ink-3 lg:group-hover:inline">
                      {formatTime(c.updated_at)}
                    </span>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        aria-label="Conversation actions"
                        aria-expanded={openId === c.id}
                        onClick={() => setOpenId(openId === c.id ? null : c.id)}
                        className="grid h-9 w-9 place-items-center rounded-[8px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100"
                      >
                        <MoreVertical size={14} strokeWidth={1.7} />
                      </button>
                      {openId === c.id ? (
                        <>
                          <button type="button" className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setOpenId(null)} />
                          <div className="card absolute right-0 z-30 mt-1 w-36 !rounded-xl !p-1 text-xs shadow-[var(--shadow-pop)]">
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
                                <button type="button" onClick={() => void rename(c.id)} className="w-full rounded-[8px] bg-accent px-2 py-1.5 text-white">{t("common.save")}</button>
                              </div>
                            ) : (
                              <>
                                <button type="button" onClick={() => { setRenaming(c.id); setRenameValue(c.title); }} className="block w-full rounded-[8px] px-2 py-2 text-left text-ink hover:bg-surface-2">Rename</button>
                                <button type="button" onClick={() => void archive(c.id)} className="block w-full rounded-[8px] px-2 py-2 text-left text-ink hover:bg-surface-2">Archive</button>
                                <button type="button" onClick={() => void remove(c.id)} className="block w-full rounded-[8px] px-2 py-2 text-left text-danger hover:bg-danger-soft">{t("common.delete")}</button>
                              </>
                            )}
                          </div>
                        </>
                      ) : null}
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
  hideBrand,
}: {
  conversations: SidebarConversation[];
  isAdmin: boolean;
  onNavigate?: () => void;
  footer?: ReactNode;
  hideBrand?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agentActive = pathname === "/chat" && searchParams.get("mode") === "agent";
  const { t } = useI18n();
  const tools = [
    { href: "/projects", label: "Projects", icon: <Code2 size={16} strokeWidth={1.7} />, detail: "Files, preview, publish" },
    { href: "/scanner", label: t("nav.scanner"), icon: <FileSearch size={16} strokeWidth={1.7} />, detail: "Images & suspicious content" },
    { href: "/scams", label: t("nav.scams"), icon: <ShieldAlert size={16} strokeWidth={1.7} />, detail: "Safety library" },
    { href: "/courses", label: t("nav.courses"), icon: <GraduationCap size={16} strokeWidth={1.7} />, detail: "Guided learning" },
    { href: "/report", label: t("nav.report"), icon: <Shield size={16} strokeWidth={1.7} />, detail: "Reporting assistant" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hideBrand ? null : (
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-3 pt-4">
          <div className="sidebar-brand min-w-0"><Logo size="md" href="/chat" /></div>
          <AiStatus />
        </div>
      )}

      <div className="shrink-0 px-3 pb-3">
        <NewChatButton
          onNavigate={onNavigate}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-accent text-[14px] font-medium text-white transition-colors duration-150 ease-out hover:bg-accent-hover"
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" /> New chat
        </NewChatButton>
        <nav className="mt-3 space-y-0.5" aria-label="Assistant modes">
          <Link href="/chat" onClick={onNavigate} className={cn("nav-item", pathname === "/chat" && !agentActive && "is-active")}>
            <MessageSquare size={16} strokeWidth={1.7} /> Chat
          </Link>
          <Link href="/chat?mode=agent" onClick={onNavigate} className={cn("nav-item", agentActive && "is-active")}>
            <Code2 size={16} strokeWidth={1.7} /> Agent
          </Link>
          <Link href="/temporary-chat" onClick={onNavigate} className={cn("nav-item", pathname.startsWith("/temporary-chat") && "is-active")}>
            <History size={16} strokeWidth={1.7} /> Private
          </Link>
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="eyebrow">Recent chats</p>
          <Link href="/history" onClick={onNavigate} className="text-[11px] font-medium text-ink-3 transition-colors hover:text-ink">View all</Link>
        </div>
        <HistoryList conversations={conversations} onNavigate={onNavigate} />

        <details className="group mt-5 border-t border-border pt-3" open={conversations.length === 0}>
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between rounded-[8px] px-1 text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
            <span className="eyebrow">More tools</span>
            <ChevronDown size={13} className="transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <nav className="mt-1 space-y-0.5" aria-label="More tools">
            {tools.map((item) => (
              <Link key={item.href} href={item.href} onClick={onNavigate} className={cn("flex min-h-11 items-center gap-2.5 rounded-[10px] px-2 transition-colors duration-150 ease-out hover:bg-surface-2", pathname === item.href || pathname.startsWith(item.href + "/") ? "bg-surface-2 text-ink" : "text-ink-2")}>
                <span className="text-ink-3">{item.icon}</span>
                <span className="min-w-0"><span className="block text-[13px] font-medium">{item.label}</span><span className="block truncate text-[11px] text-ink-3">{item.detail}</span></span>
              </Link>
            ))}
            <Link href="/emergency" onClick={onNavigate} className="mt-1 flex min-h-10 items-center gap-2.5 rounded-[10px] px-2 text-[13px] font-medium text-danger hover:bg-danger-soft"><ShieldAlert size={16} /> Emergency help</Link>
          </nav>
        </details>

        {isAdmin ? (
          <Link href="/admin" onClick={onNavigate} className="mt-3 flex min-h-10 items-center gap-2.5 rounded-[10px] border border-border px-2 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"><LayoutGrid size={16} /> {t("nav.admin")}</Link>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

function ProfileMenu({ user, onNavigate }: { user: ShellUser | null; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Open profile menu"
        className="flex w-full items-center gap-2.5 rounded-[12px] px-2 py-2 text-left transition-colors duration-150 ease-out hover:bg-surface-2"
      >
        <UserAvatar src={user?.avatarUrl} name={user?.fullName || user?.email} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{user?.fullName || "User"}</span>
          <span className="block truncate text-[11px] text-ink-3">{user?.email}</span>
        </span>
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="card fade-in absolute bottom-full left-0 z-30 mb-1 w-56 !rounded-xl !p-1.5 shadow-[var(--shadow-pop)]">
            {[
              { label: t("nav.dashboard"), href: "/dashboard" },
              { label: "Edit profile", href: "/settings?tab=account" },
              { label: "GitHub integration", href: "/settings?tab=integrations" },
              { label: t("nav.security"), href: "/security" },
              { label: t("nav.settings"), href: "/settings" },
              { label: t("nav.docs"), href: "/docs" },
              { label: t("footer.help"), href: "/support" },
            ].map((it) => (
              <Link
                key={it.href}
                href={it.href}
                onClick={() => { setOpen(false); onNavigate?.(); }}
                className="block rounded-[8px] px-3 py-2.5 text-sm text-ink transition-colors hover:bg-surface-2"
              >
                {it.label}
              </Link>
            ))}
            <div className="my-1 border-t border-border" />
            <div className="px-1 py-1"><ThemeToggle /></div>
            <SignOutButton label={t("nav.logout")} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function ShellFooter({ user, onNavigate }: { user: ShellUser | null; onNavigate?: () => void }) {
  return (
    <div className="shrink-0 border-t border-border px-3 py-2">
      <ProfileMenu user={user} onNavigate={onNavigate} />
    </div>
  );
}

export function AppShell({
  user,
  conversations,
  isAdmin,
  children,
}: {
  user: ShellUser | null;
  conversations: SidebarConversation[];
  isAdmin: boolean;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const online = useOnline();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agentActive = pathname === "/chat" && searchParams.get("mode") === "agent";
  const { t } = useI18n();
  const immersive = isImmersivePath(pathname);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <ToastProvider>
      <div className="min-h-dvh lg:flex">
        <aside className="app-sidebar fixed inset-y-0 left-0 z-40 hidden w-[276px] lg:block">
          <SidebarBody
            conversations={conversations}
            isAdmin={isAdmin}
            footer={<ShellFooter user={user} />}
          />
        </aside>

        {drawerOpen ? (
          <>
            <button
              type="button"
              className="fade-in fixed inset-0 z-40 bg-[#070B14]/50 backdrop-blur-sm lg:hidden"
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
            />
            <aside className="app-sidebar drawer-in fixed inset-y-0 left-0 z-50 flex w-[min(88vw,20rem)] flex-col pt-[env(safe-area-inset-top)] lg:hidden">
              <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-3">
                <div className="sidebar-brand min-w-0">
                  <Logo size="md" href="/chat" />
                </div>
                <button type="button" onClick={() => setDrawerOpen(false)} aria-label="Close menu" className="grid h-11 w-11 place-items-center rounded-[10px] text-ink-2 hover:bg-surface-2">
                  <X size={16} strokeWidth={1.6} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <SidebarBody
                  conversations={conversations}
                  isAdmin={isAdmin}
                  hideBrand
                  onNavigate={() => setDrawerOpen(false)}
                  footer={<ShellFooter user={user} onNavigate={() => setDrawerOpen(false)} />}
                />
              </div>
            </aside>
          </>
        ) : null}

        <header className="app-glass sticky top-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end lg:hidden">
          <div className="flex h-14 w-full items-center justify-between gap-2 px-2">
          <div className="flex min-w-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="grid h-11 w-11 place-items-center rounded-[10px] text-ink-2 hover:bg-surface-2"
            >
              <Menu size={18} strokeWidth={1.6} />
            </button>
            <div className="sidebar-brand">
              <Logo size="sm" href="/chat" />
            </div>
            <AiStatus className="hidden sm:inline-flex" />
          </div>
          <div className="flex items-center gap-0.5">
            <NotificationsBell placement="down" />
            <Link
              href="/temporary-chat"
              aria-label={t("nav.tempChat")}
              className={cn(
                "grid h-11 w-11 place-items-center rounded-[10px]",
                pathname.startsWith("/temporary-chat") ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2",
              )}
            >
              <History size={16} strokeWidth={1.6} />
            </Link>
            <NewChatButton
              ariaLabel={t("chat.new")}
              className="grid h-11 w-11 place-items-center rounded-[10px] text-ink-2 hover:bg-surface-2"
            >
              <Plus size={16} strokeWidth={1.6} />
            </NewChatButton>
          </div>
          </div>
        </header>

        {!online ? (
          <div className="fixed inset-x-0 top-14 z-[60] border-b border-danger/40 bg-danger-soft px-4 py-2 text-center text-sm font-medium text-danger lg:top-0" role="alert">
            You&apos;re offline — reconnecting…
          </div>
        ) : null}

        <div
          className={cn(
            "min-w-0 flex-1 lg:pl-[276px]",
            immersive
              ? "flex h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] flex-col overflow-hidden pb-[calc(var(--app-bottom-nav)+env(safe-area-inset-bottom))] lg:h-dvh lg:pb-0"
              : "pb-[calc(var(--app-bottom-nav)+env(safe-area-inset-bottom))] lg:pb-0",
          )}
        >
          {!immersive ? (
            <div className="hidden h-12 shrink-0 items-center justify-end gap-1 border-b border-border px-4 lg:flex">
              <NotificationsBell placement="down" />
              <ThemeToggle compact />
              <Link
                href="/settings?tab=account"
                aria-label="Edit profile"
                className="ml-1 grid h-11 w-11 place-items-center rounded-[10px] text-ink-2 transition-colors hover:bg-surface-2"
              >
                <UserAvatar src={user?.avatarUrl} name={user?.fullName || user?.email} size={28} />
              </Link>
            </div>
          ) : null}
          <div
            className={cn(
              immersive
                ? pathname.startsWith("/projects/")
                  ? "mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-2 sm:px-4"
                  : "mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-3 sm:px-6"
                : "mx-auto max-w-4xl px-4 py-5 sm:px-6 lg:py-7",
            )}
          >
            {children}
          </div>
        </div>

        <nav
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
          aria-label="Bottom navigation"
        >
          <div className="mx-auto grid max-w-lg grid-cols-5">
            {[
              { href: "/chat", label: t("nav.chat"), icon: <MessageSquare size={17} strokeWidth={1.6} /> },
              { href: "/chat?mode=agent", label: "Agent", icon: <Code2 size={17} strokeWidth={1.6} /> },
              { href: "/scanner", label: t("nav.scanner"), icon: <FileSearch size={17} strokeWidth={1.6} /> },
              { href: "/courses", label: t("nav.courses"), icon: <GraduationCap size={17} strokeWidth={1.6} /> },
              { href: "/settings", label: t("nav.settings"), icon: <User size={17} strokeWidth={1.6} /> },
            ].map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors",
                  n.href.includes("mode=agent")
                    ? agentActive ? "text-accent" : "text-ink-3 hover:text-ink"
                    : n.href === "/chat"
                      ? (pathname === "/chat" || pathname.startsWith("/chat/")) && !agentActive ? "text-ink" : "text-ink-3 hover:text-ink"
                      : pathname === n.href ? "text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                <span aria-hidden="true">{n.icon}</span>
                <span className="max-w-full truncate">{n.label}</span>
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </ToastProvider>
  );
}
