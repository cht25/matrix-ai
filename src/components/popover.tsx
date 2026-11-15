"use client";

// Contextual menu used across the chat surface (message actions, More,
// Settings, Models, attach).
//
//   Desktop / tablet → a floating panel, portalled to <body> and positioned
//                      against its trigger, flipped above when there is no
//                      room below. It can never be clipped by the chat
//                      scrollport or pushed under the composer.
//   Phone            → a bottom sheet with full-width, 48px rows (opt-in via
//                      `sheetTitle`), because a floating menu next to a thumb
//                      is hard to hit.
//
// Real conditional rendering: the panel is mounted only while open — never
// painted and hidden with CSS. Keyboard: ↑/↓/Home/End move, Enter/Space
// activate, Esc or Tab close and return focus to the trigger.

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { BottomSheet } from "@/components/bottom-sheet";
import { useIsCompact } from "@/lib/client/use-media-query";
import { cn } from "@/lib/utils";

const MenuDensity = createContext<"compact" | "touch">("compact");
const ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const GAP = 6;
const EDGE = 8;

type TriggerProps = { open: boolean; toggle: () => void; close: () => void; aria: Record<string, unknown> };

export function Popover({
  trigger,
  children,
  align = "right",
  panelClassName,
  label,
  open: controlledOpen,
  onOpenChange,
  sheetTitle,
  role = "menu",
  viewKey,
  className,
}: {
  trigger: (props: TriggerProps) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: "left" | "right";
  panelClassName?: string;
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Present the menu as a bottom sheet with this title on phones. */
  sheetTitle?: string;
  /** "dialog" for panels that hold inputs rather than a list of actions. */
  role?: "menu" | "dialog";
  /** Changes when the menu swaps to another page; focus follows the new page. */
  viewKey?: string;
  className?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sheetContentRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const compact = useIsCompact();
  const asSheet = Boolean(sheetTitle) && compact;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", top: 0, left: 0 });

  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);

  const focusTrigger = useCallback(() => {
    rootRef.current?.querySelector<HTMLElement>("button, [href], [tabindex]")?.focus({ preventScroll: true });
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(focusTrigger);
  }, [setOpen, focusTrigger]);

  // Position against the trigger; flip above when the space below is short.
  const place = useCallback(() => {
    const anchor = rootRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const below = viewportHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const openUp = height > below && above > below;
    const maxHeight = Math.max(160, openUp ? above : below);
    const top = openUp ? Math.max(EDGE, anchor.top - GAP - Math.min(height, maxHeight)) : anchor.bottom + GAP;
    const preferred = align === "right" ? anchor.right - width : anchor.left;
    const left = Math.min(Math.max(EDGE, preferred), Math.max(EDGE, viewportWidth - width - EDGE));
    setStyle({ top, left, maxHeight, visibility: "visible" });
  }, [align]);

  useLayoutEffect(() => {
    if (!open || asSheet) return;
    place();
  }, [open, asSheet, place]);

  useEffect(() => {
    if (!open || asSheet) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    let frame = 0;
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    // Focus follows the panel: the first action of a menu, the first field of
    // a dialog. Keyboard and screen-reader users land inside what just opened.
    const focusFrame = requestAnimationFrame(() => {
      const target = role === "menu"
        ? panelRef.current?.querySelector<HTMLElement>(ITEMS)
        : panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, asSheet, place, close, setOpen, role]);

  // A menu that swaps pages (Settings → Response strategy) keeps focus inside
  // itself: the first action of the new page takes it.
  const firstView = useRef(viewKey);
  useEffect(() => {
    if (!open) { firstView.current = viewKey; return; }
    if (firstView.current === viewKey) return;
    firstView.current = viewKey;
    const frame = requestAnimationFrame(() => {
      if (!asSheet) place();
      (asSheet ? sheetContentRef.current : panelRef.current)?.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [viewKey, open, asSheet, place]);

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (role !== "menu") {
      // A panel with inputs keeps Tab inside itself (it is portalled to the
      // end of <body>, so tabbing out would land in the browser chrome).
      if (event.key !== "Tab") return;
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    // The floating menu closes on Tab; the sheet keeps its own focus trap.
    if (event.key === "Tab") { if (!asSheet) setOpen(false); return; }
    const items = Array.from((asSheet ? sheetContentRef.current : panelRef.current)?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    items[next].focus({ preventScroll: true });
  }

  const content = open ? children({ close: () => close(!asSheet) }) : null;

  return (
    <span ref={rootRef} className={cn("relative inline-flex", className)}>
      {trigger({
        open,
        toggle: () => setOpen(!open),
        close: () => setOpen(false),
        aria: {
          "aria-expanded": open,
          "aria-haspopup": asSheet ? "dialog" : role,
          "aria-controls": open && !asSheet ? panelId : undefined,
        },
      })}
      {open && asSheet ? (
        <BottomSheet open onClose={() => setOpen(false)} title={sheetTitle ?? label ?? "Menu"}>
          <MenuDensity.Provider value="touch">
            <div ref={sheetContentRef} role={role === "menu" ? "menu" : undefined} aria-label={label} onKeyDown={role === "menu" ? onPanelKeyDown : undefined}>{content}</div>
          </MenuDensity.Provider>
        </BottomSheet>
      ) : null}
      {open && !asSheet && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role={role}
              aria-label={label}
              aria-modal={role === "dialog" ? false : undefined}
              onKeyDown={onPanelKeyDown}
              style={style}
              className={cn(
                "menu-pop fixed z-[80] min-w-44 overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-pop)]",
                panelClassName,
              )}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

export function MenuItem({
  children,
  icon,
  onClick,
  active,
  disabled,
  danger,
  hint,
  checked,
  description,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
  /** Renders the row as a single-choice option with a check mark. */
  checked?: boolean;
  description?: string;
}) {
  const touch = useContext(MenuDensity) === "touch";
  const selected = checked ?? active;
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked === undefined ? undefined : checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg text-left font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40",
        touch ? "min-h-12 px-3 text-[15px]" : "min-h-9 px-2.5 py-1.5 text-[13px]",
        danger
          ? "text-danger hover:bg-danger-soft focus-visible:bg-danger-soft"
          : selected
            ? "bg-accent-soft text-accent"
            : "text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:bg-surface-2 focus-visible:text-ink",
      )}
    >
      {icon ? <span className={cn("grid shrink-0 place-items-center", touch ? "h-5 w-5" : "h-4 w-4")} aria-hidden="true">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description ? <span className={cn("block truncate font-normal text-ink-3", touch ? "text-[12.5px]" : "text-[11.5px]")}>{description}</span> : null}
      </span>
      {hint ? <span className="shrink-0 font-mono text-[10px] text-ink-3">{hint}</span> : null}
      {checked ? <Check size={touch ? 17 : 14} className="shrink-0 text-accent" aria-hidden="true" /> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-3">{children}</p>;
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}
