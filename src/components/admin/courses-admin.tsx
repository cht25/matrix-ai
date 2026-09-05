"use client";

import { useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { errorCodeOf, mapAdminError } from "@/lib/admin-errors";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { CourseEditor } from "@/components/admin/course-editor";

type Course = { id: string; slug: string; title: string; level: string; status: string; sort_order: number };

export function CoursesAdmin({ codes, courses }: { codes: string[]; courses: Course[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(c: Course) {
    setBusy(c.id);
    const next = c.status === "published" ? "draft" : "published";
    try {
      await rpc("course_status", { id: c.id, status: next });
      await rpc("log_audit", { action: "course_status_changed", target_type: "courses", target_id: c.id, reason: `→ ${next}` }).catch(() => {});
      setMsg(`"${c.title}" is now ${next}. Audit logged.`);
    } catch (err) {
      setMsg(friendly(err, "UPDATE_FAILED"));
    }
    setBusy(null);
    window.location.reload();
  }

  if (!codes.includes("content.manage")) {
    return <Card><p className="text-sm text-ink-2">You need the <strong>content.manage</strong> permission (content_admin / super_admin).</p></Card>;
  }

  return (
    <div className="space-y-4">
    <CourseEditor />
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
    </div>
  );
}

/** Internal code -> human sentence. The raw code stays in the console only. */
function friendly(err: unknown, fallback: string): string {
  const view = mapAdminError(errorCodeOf(err, fallback));
  console.error("[MATRIX admin]", view.code, err);
  return `${view.title} — ${view.detail}`;
}
