"use client";

import { useEffect, useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Badge, Card, Spinner } from "@/components/ui";
import { timeAgo } from "@/lib/utils";

type Event = { id: string; user_id: string; event_type: string; created_at: string };
type Session = { id: string; user_id: string; device_name: string; last_seen_at: string; revoked_at: string | null };

export function SecurityAdmin({ codes }: { codes: Set<string> }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    if (!codes.has("security.view")) return;
    Promise.all([
      rpc<Event[]>("admin_security_events").catch(() => [] as Event[]),
      rpc<Session[]>("admin_sessions").catch(() => [] as Session[]),
    ]).then(([e, s]) => {
      setEvents(e ?? []);
      setSessions(s ?? []);
    });
  }, [codes]);

  if (!codes.has("security.view")) {
    return <Card><p className="text-sm text-ink-2">You need the <strong>security.view</strong> permission (security_admin / super_admin / auditor).</p></Card>;
  }
  if (!events || !sessions) return <Card className="flex items-center gap-2 text-ink-2"><Spinner /> Loading…</Card>;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h2 className="font-bold text-ink">Security events</h2>
        {events.length === 0 ? <p className="mt-2 text-sm text-ink-3">No events.</p> : (
          <ul className="mt-3 space-y-2">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge className="border-border bg-surface capitalize text-ink-2">{e.event_type.replaceAll("_", " ")}</Badge>
                  <span className="truncate font-mono text-xs text-ink-3">{e.user_id.slice(0, 8)}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-3">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <h2 className="font-bold text-ink">Sessions</h2>
        {sessions.length === 0 ? <p className="mt-2 text-sm text-ink-3">No sessions.</p> : (
          <ul className="mt-3 space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{s.device_name || "Device"} {s.revoked_at ? <Badge className="ml-1 border-border bg-surface text-ink-3">revoked</Badge> : null}</p>
                  <p className="font-mono text-xs text-ink-3">{s.user_id.slice(0, 8)} · last seen {timeAgo(s.last_seen_at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
