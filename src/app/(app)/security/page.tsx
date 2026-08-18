import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { Badge, Card, EmptyState } from "@/components/ui";
import { RevokeSessionButton } from "@/components/revoke-session-button";
import { timeAgo } from "@/lib/utils";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const [eventsRes, sessionsRes] = await Promise.all([
    db.from("security_events").select("id, event_type, metadata, created_at").eq("user_id", user!.id).order("created_at", { ascending: false }).limit(50),
    db.from("user_sessions").select("id, device_name, last_seen_at, revoked_at, user_agent").eq("user_id", user!.id).order("last_seen_at", { ascending: false }).limit(20),
  ]);

  const events = (eventsRes.data ?? []) as { id: string; event_type: string; metadata: Record<string, unknown>; created_at: string }[];
  const sessions = (sessionsRes.data ?? []) as { id: string; device_name: string; last_seen_at: string; revoked_at: string | null; user_agent: string }[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Security</h1>
        <p className="mt-1 text-slate-500">
          Your login history, active sessions and security events. Sensitive details are never logged —
          only safe metadata.
        </p>
      </div>

      <Card>
        <h2 className="font-bold text-slate-900">Active sessions</h2>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No device sessions recorded yet. They appear when you sign in.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-slate-800">
                    {s.device_name || "Device"} {s.revoked_at ? <Badge className="ml-2 border-slate-200 bg-white text-slate-400">revoked</Badge> : null}
                  </p>
                  <p className="truncate text-xs text-slate-400">Last seen {timeAgo(s.last_seen_at)}</p>
                </div>
                {!s.revoked_at ? <RevokeSessionButton sessionId={s.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="font-bold text-slate-900">Security events</h2>
        {events.length === 0 ? (
          <EmptyState title="No events yet" body="Logins, password changes and MFA updates will appear here." />
        ) : (
          <ul className="mt-3 space-y-2">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <span className="capitalize text-slate-700">{e.event_type.replaceAll("_", " ")}</span>
                <span className="text-xs text-slate-400">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
