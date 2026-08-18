"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui";

export function CompleteLessonButton({
  lessonId,
  completed,
  nextHref,
  finalLabel = "Mark as complete & continue →",
}: {
  lessonId: string;
  completed: boolean;
  nextHref: string | null;
  finalLabel?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function complete() {
    setBusy(true);
    const supabase = createClient();
    await supabase.rpc("update_course_progress", { p_lesson_id: lessonId, p_status: "completed" });
    router.refresh();
    if (nextHref) {
      router.push(nextHref);
    } else {
      setBusy(false);
    }
  }

  return (
    <Button onClick={() => void complete()} disabled={busy || completed} className={completed ? "opacity-60" : ""}>
      {completed ? "✓ Completed" : busy ? "Saving…" : nextHref ? "Mark as complete & continue →" : finalLabel}
    </Button>
  );
}
