"use client";

// Contextual message actions (product spec §15/§16) — one row for every
// message, Chat and Agent alike.
//
// A normal reply gets:   Copy   Regenerate   More ▾
// A code reply gets:     Copy code   Run   Explain   More ▾
// An image gets:         Save   Regenerate   Edit prompt   More ▾
// A user message gets:   Copy   Edit   More ▾
//
// Which actions exist is decided by the caller (planResponseActions() in
// lib/ai/intent for replies) — this component only renders what it is given,
// and the More menu only holds actions that are valid for that message.
//
// Pointer devices get compact buttons and a floating menu; touch devices get
// 44px targets and the menu as a bottom sheet with full-width rows.

import { Fragment, memo, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { MenuItem, MenuSeparator, Popover } from "@/components/popover";
import { cn } from "@/lib/utils";

export type ChatAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  /** Destructive (Delete): rendered in the danger colour, last in the menu. */
  danger?: boolean;
  /** Starts a new group in the More menu. */
  separated?: boolean;
};

export const ResponseActions = memo(function ResponseActions({
  primary,
  overflow,
  align = "start",
  quiet = false,
  menuLabel = "More actions",
  className,
}: {
  primary: ChatAction[];
  overflow: ChatAction[];
  align?: "start" | "end";
  /** Fade the row until the message is hovered or focused (pointer devices). */
  quiet?: boolean;
  menuLabel?: string;
  className?: string;
}) {
  const visible = primary.filter(Boolean);
  if (!visible.length && !overflow.length) return null;

  return (
    <div
      className={cn("msg-actions flex flex-wrap items-center gap-0.5", align === "end" && "justify-end", className)}
      data-quiet={quiet ? "true" : undefined}
      role="group"
      aria-label="Message actions"
    >
      {visible.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.title ?? action.label}
          aria-pressed={action.active}
          className={cn("msg-action", action.active && "!text-accent")}
        >
          {action.icon ? <span aria-hidden="true" className="grid h-4 w-4 shrink-0 place-items-center">{action.icon}</span> : null}
          <span>{action.label}</span>
        </button>
      ))}
      {overflow.length ? (
        <Popover
          label={menuLabel}
          sheetTitle={menuLabel}
          align={align === "end" ? "right" : "left"}
          panelClassName="w-56"
          trigger={({ toggle, aria }) => (
            <button type="button" onClick={toggle} title="More" aria-label={menuLabel} className="msg-action" {...aria}>
              <MoreHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
              <span className="hidden sm:inline">More</span>
            </button>
          )}
        >
          {({ close }) => (
            <>
              {overflow.map((action, index) => (
                <Fragment key={action.id}>
                  {action.separated && index > 0 ? <MenuSeparator /> : null}
                  <MenuItem
                    icon={action.icon}
                    disabled={action.disabled}
                    active={action.active}
                    danger={action.danger}
                    onClick={() => {
                      close();
                      action.onClick();
                    }}
                  >
                    {action.label}
                  </MenuItem>
                </Fragment>
              ))}
            </>
          )}
        </Popover>
      ) : null}
    </div>
  );
});
