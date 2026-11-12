"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, BellRing } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { cachedRequest, invalidate, peekCache, subscribe } from "@/lib/client/cache";
import {
  isTauriApp,
  notifyWorkDone,
  requestDesktopNotificationPermission,
} from "@/lib/client/work-notifications";

// The bell renders in both the mobile top bar and the desktop chrome. Sharing
// one cached request keeps that to a single /api/rpc call per page.
const CACHE_KEY = "notifications:list";

type Item = { id: string; title: string; body: string; link: string; read_at: string | null; created_at: string };

// Shared across both mobile + desktop bell mounts so duplicate OS notifications
// are never fired for the same notification id.
let hydratedOnce = false;
const notifiedIds = new Set<string>();

export function NotificationsBell({ placement = "auto" }: { placement?: "up" | "down" | "auto" }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>(() => peekCache<Item[]>(CACHE_KEY) ?? []);
  const [perm, setPerm] = useState<NotificationPermission | "tauri" | "unsupported">("granted");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (isTauriApp()) {
      setPerm("tauri");
    } else if (typeof window !== "undefined" && "Notification" in window) {
      setPerm(window.Notification.permission);
    } else {
      setPerm("unsupported");
    }
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const load = useCallback(async (force = false) => {
    const data = await cachedRequest(
      CACHE_KEY,
      () => rpc<Item[]>("notifications_list").catch(() => [] as Item[]),
      { ttlMs: 25_000, force },
    );
    const list = data ?? [];
    if (!hydratedOnce) {
      for (const item of list) notifiedIds.add(item.id);
      hydratedOnce = true;
    } else {
      for (const item of list) {
        if (!item.read_at && !notifiedIds.has(item.id)) {
          notifiedIds.add(item.id);
          void notifyWorkDone({
            title: item.title,
            body: item.body,
            link: item.link || undefined,
            refreshBell: false,
          });
        }
      }
    }
    if (mountedRef.current) setItems(list);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe<Item[]>(CACHE_KEY, setItems);
    void load();
    const pollTimer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load(true);
    }, 30_000);
    return () => {
      unsubscribe();
      window.clearInterval(pollTimer);
    };
  }, [load]);

  const unread = items.filter((i) => !i.read_at).length;

  async function markAll() {
    await rpc("notifications_mark_read", { all: true }).catch(() => {});
    invalidate(CACHE_KEY);
    await load(true);
  }

  async function enableDesktopAlerts() {
    const next = await requestDesktopNotificationPermission();
    setPerm(next);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); if (!open) void load(true); }}
        className="relative grid h-10 w-10 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Bell size={16} />
        {unread ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" /> : null}
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className={placement === "down" ? "card absolute right-0 top-full z-30 mt-1 w-80 !rounded-xl !p-2 shadow-[var(--shadow-pop)]" : "card absolute bottom-full right-0 z-30 mb-1 w-80 !rounded-xl !p-2 shadow-[var(--shadow-pop)]"}>
            <div className="mb-1 flex items-center justify-between px-2 py-1">
              <p className="text-xs font-semibold text-ink">Notifications</p>
              {unread ? <button type="button" className="text-[11px] text-accent" onClick={() => void markAll()}>Mark all read</button> : null}
            </div>
            {perm === "default" ? (
              <button
                type="button"
                onClick={() => void enableDesktopAlerts()}
                className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-accent/25 bg-accent-soft/20 px-2.5 py-2 text-left text-[11px] font-medium text-ink hover:bg-accent-soft/35"
              >
                <BellRing size={13} className="shrink-0 text-accent" />
                <span>Enable desktop notifications when work finishes</span>
              </button>
            ) : null}
            {items.length === 0 ? <p className="px-2 py-4 text-xs text-ink-3">No notifications yet.</p> : (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {items.slice(0, 14).map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.link || "#"}
                      onClick={() => { void rpc("notifications_mark_read", { id: item.id }).catch(() => {}); invalidate(CACHE_KEY); setOpen(false); }}
                      className="block rounded-md px-2 py-2 hover:bg-surface-2"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-ink">{item.title}</span>
                        {!item.read_at ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                      </span>
                      <span className="block text-[11px] text-ink-3">{item.body}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
