"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { rpc } from "@/lib/client/api";

type Item = { id: string; title: string; body: string; link: string; read_at: string | null; created_at: string };

export function NotificationsBell({ placement = "auto" }: { placement?: "up" | "down" | "auto" }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);

  async function load() {
    const data = await rpc<Item[]>("notifications_list").catch(() => []);
    setItems(data ?? []);
  }

  useEffect(() => { void load(); }, []);

  const unread = items.filter((i) => !i.read_at).length;

  async function markAll() {
    await rpc("notifications_mark_read", { all: true }).catch(() => {});
    await load();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); if (!open) void load(); }}
        className="relative grid h-10 w-10 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
      >
        <Bell size={16} />
        {unread ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" /> : null}
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-20 cursor-default" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className={placement === "down" ? "card absolute right-0 top-full z-30 mt-1 w-72 !rounded-xl !p-2 shadow-[var(--shadow-pop)]" : "card absolute bottom-full right-0 z-30 mb-1 w-72 !rounded-xl !p-2 shadow-[var(--shadow-pop)]"}>
            <div className="mb-1 flex items-center justify-between px-2 py-1">
              <p className="text-xs font-semibold text-ink">Notifications</p>
              {unread ? <button type="button" className="text-[11px] text-accent" onClick={() => void markAll()}>Mark all read</button> : null}
            </div>
            {items.length === 0 ? <p className="px-2 py-4 text-xs text-ink-3">No notifications yet.</p> : (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {items.slice(0, 12).map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.link || "#"}
                      onClick={() => { void rpc("notifications_mark_read", { id: item.id }).catch(() => {}); setOpen(false); }}
                      className="block rounded-md px-2 py-2 hover:bg-surface-2"
                    >
                      <span className="block text-xs font-medium text-ink">{item.title}</span>
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
