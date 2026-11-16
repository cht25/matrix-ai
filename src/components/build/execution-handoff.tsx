"use client";

// =============================================================================
// Execution hand-off — "awaiting approval".
//
// Shown when someone asks for real project work (build, change, publish) in a
// conversation mode. A chat reply cannot do that work, and a reply that sounds
// as if it did would be untrue — so nothing is sent to the model. The request
// waits here for one tap: start the Agent, or get a chat answer instead.
// =============================================================================

import { X } from "lucide-react";
import { handoffCopy, type HandoffReason } from "@/lib/ai/execution-policy";
import { awaitingApprovalOutcome } from "@/lib/ai/task-outcome";
import { TaskOutcomeBadge } from "@/components/build/task-outcome";

export function ExecutionHandoff({
  reason,
  request,
  busy,
  onApprove,
  onAnswerInChat,
  onDismiss,
}: {
  reason: HandoffReason;
  /** The user's own words, shown back so it is clear what will run. */
  request: string;
  busy?: boolean;
  onApprove: () => void;
  onAnswerInChat: () => void;
  onDismiss: () => void;
}) {
  const copy = handoffCopy(reason);
  const outcome = awaitingApprovalOutcome(copy.detail);
  return (
    <section className="fade-in rounded-xl border border-accent/40 bg-surface p-4" aria-label={copy.title} data-execution-handoff={reason}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <TaskOutcomeBadge outcome={outcome} />
          <h3 className="mt-2 text-sm font-semibold text-ink">{copy.title}</h3>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{copy.detail}</p>
      <p className="mt-2 line-clamp-3 break-words rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink">{request}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {/* One line each: on a narrow screen they stack instead of wrapping their labels. */}
        <button type="button" onClick={onApprove} disabled={busy} className="btn btn-primary min-h-11 flex-1 whitespace-nowrap sm:flex-none">
          {copy.action}
        </button>
        <button type="button" onClick={onAnswerInChat} disabled={busy} className="btn btn-outline min-h-11 flex-1 whitespace-nowrap sm:flex-none">
          Answer in chat instead
        </button>
      </div>
    </section>
  );
}
