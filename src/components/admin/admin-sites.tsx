"use client";

import { useEffect, useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { Alert, Button, Card, Spinner, TableSkeleton } from "@/components/ui";

type Site = { slug: string; owner_id: string; url: string; status: string; updated_at: string };

export function AdminSites() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      setSites(await rpc<Site[]>("admin_live_sites"));
    } catch {
      setSites([]);
    }
  }

  useEffect(() => { void load(); }, []);

  async function unpublish(slug: string) {
    try {
      await rpc("admin_unpublish_site", { slug, reason: "admin moderation" });
      setMsg(`Unpublished /s/${slug}`);
      await load();
    } catch (err) {
      setMsg(friendly(err, "Unpublish failed."));
    }
  }

  if (!sites) return <Card><TableSkeleton rows={4} cols={3} label="Loading…" /></Card>;

  return (
    <Card>
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      <h2 className="font-bold text-ink">Live sites ({sites.length})</h2>
      {!sites.length ? <p className="mt-2 text-sm text-ink-3">No published sites.</p> : (
        <ul className="mt-3 space-y-2">
          {sites.map((s) => (
            <li key={s.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
              <div>
                <a href={s.url} className="font-medium text-accent" target="_blank" rel="noreferrer">{s.url}</a>
                <p className="text-xs text-ink-3">owner {s.owner_id.slice(0, 8)}…</p>
              </div>
              <Button variant="outline" className="!min-h-9 !px-3 text-xs" onClick={() => void unpublish(s.slug)}>Unpublish</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Internal code -> human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[MATRIX admin]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
