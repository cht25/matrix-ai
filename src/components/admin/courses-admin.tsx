"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";

type Course = { id: string; slug: string; title: string; level: string; status: string; sort_order: number };

export function CoursesAdmin({ codes, courses }: { codes: Set<string>; courses: Course[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(c: Course) {
    setBusy(c.id);
    const next = c.status === "published" ? "draft" : "published";
    const supabase = createClient();
    const { error } = await supabase.from("courses").update({ status: next }).eq("id", c.id);
    if (error) {
      setMsg(error.message);
    } else {
      await supabase.rpc("log_audit", { p_action: "course_status_changed", p_target_type: "courses", p_target_id: c.id, p_reason: `→ ${next}` });
      setMsg(`"${c.title}" is now ${next}. Audit logged.`);
    }
    setBusy(null);
    window.location.reload();
  }

  if (!codes.has("content.manage")) {
    return <Card><p className="text-sm text-ink-2">You need the <strong>content.manage</strong> permission (content_admin / super_admin).</p></Card>;
  }

  return (
    <Card>
      <h2 className="font-bold text-ink">Courses ({courses.length})</h2>
      <p className="mt-1 text-xs text-ink-3">Only published courses are visible to users. Status changes are audited.</p>
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      <ul className="mt-3 space-y-2">
        {courses.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{c.title}</p>
              <p className="text-xs text-ink-3">{c.slug} · {c.level} · order {c.sort_order}</p>
            </div>
            <Badge className={c.status === "published" ? "border-success/30 bg-success-soft text-success" : "border-border bg-surface text-ink-3"}>{c.status}</Badge>
            <Button variant="outline" onClick={() => void toggle(c)} disabled={busy === c.id} className="!min-h-9 !px-3 !py-1.5 text-xs">
              {busy === c.id ? <Spinner /> : c.status === "published" ? "Unpublish" : "Publish"}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
