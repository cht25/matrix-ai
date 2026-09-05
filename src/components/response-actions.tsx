"use client";

// Contextual response actions (product spec §15/§16).
//
// A normal reply gets:   Copy   Regenerate   More ▾
// A code reply gets:     Copy code   Run   Explain   More ▾
// An image gets:         Save   Regenerate   Edit prompt   More ▾
//
// Which actions exist is decided by planResponseActions() in lib/ai/intent —
// this component only renders what it is given, and the More menu only holds
// actions that are valid for that specific response.

import type { ReactNode } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { cn } from "@/lib/utils";

export type ChatAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  active?: boolean;
};

const CHIP =
  "action-chip inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

export function ResponseActions({
  primary,
  overflow,
  align = "start",
  className,
}: {
  primary: ChatAction[];
  overflow: ChatAction[];
  align?: "start" | "end";
  className?: string;
}) {
  const visible = primary.filter(Boolean);
  if (!visible.length && !overflow.length) return null;

  return (
    <div
      className={cn("mt-1.5 flex flex-wrap items-center gap-0.5", align === "end" && "justify-end", className)}
      role="group"
      aria-label="Response actions"
    >
      {visible.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.title ?? action.label}
          aria-pressed={action.active}
          className={cn(CHIP, action.active && "bg-accent-soft text-accent hover:text-accent")}
        >
          {action.icon ? <span aria-hidden="true" className="grid h-3.5 w-3.5 place-items-center">{action.icon}</span> : null}
          {action.label}
        </button>
      ))}
      {overflow.length ? (
        <Popover
          label="More response actions"
          trigger={({ toggle, open, aria }) => (
            <button
              type="button"
              onClick={toggle}
              title="More"
              className={cn(CHIP, open && "bg-surface-2 text-ink")}
              {...aria}
            >
              <MoreHorizontal size={13} strokeWidth={1.8} aria-hidden="true" />
              More
              <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        >
          {({ close }) => (
            <>
              {overflow.map((action) => (
                <MenuItem
                  key={action.id}
                  icon={action.icon}
                  disabled={action.disabled}
                  active={action.active}
                  onClick={() => {
                    close();
                    action.onClick();
                  }}
                >
                  {action.label}
                </MenuItem>
              ))}
            </>
          )}
        </Popover>
      ) : null}
    </div>
  );
}
