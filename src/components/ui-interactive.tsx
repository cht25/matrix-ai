"use client";

// Interactive UI primitives (need browser APIs / event handlers).
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, Spinner } from "@/components/ui";

// ---------------------------------------------------------------------------
// Modal — accessible dialog (Esc to close, focus trap entry, labelled).
// ---------------------------------------------------------------------------
export function Modal({
  open, onClose, title, description, children, footer, size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("[data-autofocus],button,select,input")?.focus();
    }, 20);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          "card modal-pop max-h-[92vh] w-full overflow-y-auto !rounded-t-2xl !rounded-b-none !p-5 sm:!rounded-2xl",
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
            {description ? <p id={descId} className="mt-1 text-sm leading-relaxed text-ink-2">{description}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="-mr-1 -mt-1 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink">✕</button>
        </div>
        {children ? <div className="mt-4">{children}</div> : null}
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Confirmation dialog for destructive operations. */
export function ConfirmDialog({
  open, onClose, onConfirm, title, description, confirmLabel = "Confirm", danger = true, busy = false,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; description: string; confirmLabel?: string; danger?: boolean; busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy} data-autofocus>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}{confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/** Live-region status line — screen-reader friendly success/failure feedback. */
export function StatusMessage({ tone, children }: { tone: "success" | "danger" | "info"; children: ReactNode }) {
  const tones = {
    success: "border-success/40 bg-success-soft text-success",
    danger: "border-danger/40 bg-danger-soft text-danger",
    info: "border-border-strong bg-surface-2 text-ink-2",
  };
  return (
    <p role="status" aria-live="polite" className={cn("fade-in inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium", tones[tone])}>
      {children}
    </p>
  );
}
