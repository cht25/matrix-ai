import { cn } from "@/lib/utils";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
>(function Button({ variant = "primary", className, children, type = "button", ...props }, ref) {
  // The button system lives in styles/components.css (.btn + variants), so
  // hover / active / focus / disabled / loading states are defined once and
  // every button — including plain <a class="btn"> links — matches.
  const styles: Record<ButtonVariant, string> = {
    primary: "btn-primary",
    secondary: "btn-secondary",
    ghost: "btn-ghost",
    danger: "btn-danger",
    outline: "btn-outline",
  };
  return (
    <button
      ref={ref}
      type={type}
      className={cn("btn", styles[variant], className)}
      {...props}
    >
      {children}
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn("input-base", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn("input-base min-h-11 resize-none", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn("input-base cursor-pointer", className)} {...props}>
      {children}
    </select>
  );
});

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return <div id={id} className={cn("card p-5", className)}>{children}</div>;
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium tracking-wide text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Alert({ tone = "info", children }: { tone?: "info" | "success" | "warning" | "danger"; children: ReactNode }) {
  const tones = {
    info: "border-border-strong bg-surface-2 text-ink-2",
    success: "border-success/40 bg-success-soft text-success",
    warning: "border-warning/40 bg-warning-soft text-warning",
    danger: "border-danger/40 bg-danger-soft text-danger",
  };
  return <div className={cn("rounded-xl border px-4 py-3 text-sm leading-relaxed", tones[tone])}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block h-4 w-4 animate-spin rounded-full border-[1.5px] border-current border-t-transparent", className)}
      role="status"
      aria-label="Loading"
    />
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      {icon ? <div className="text-ink-3">{icon}</div> : null}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {body ? <p className="max-w-sm text-sm leading-relaxed text-ink-2">{body}</p> : null}
      {action}
    </div>
  );
}

export function Menu({ trigger, items }: { trigger: ReactNode; items: { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }[] }) {
  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{trigger}</summary>
      <div className="card fade-in absolute right-0 z-30 mt-1 w-44 overflow-hidden !rounded-xl !p-1 shadow-[var(--shadow-pop)]">
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            onClick={it.onClick}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
              it.danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-surface-2",
            )}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Skeleton — never show a blank page while data loads.
// ---------------------------------------------------------------------------
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-surface-2", className)} />;
}

export function TableSkeleton({ rows = 5, cols = 5, label = "Loading…" }: { rows?: number; cols?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-2">
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
        <Spinner className="h-3.5 w-3.5" /> {label}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid gap-3 rounded-xl border border-border bg-surface p-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={cn("h-4", c === 0 && "w-4/5", c > 0 && "w-3/5")} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorState — human-readable failure surface. Internal codes stay in a small
// monospace reference line, never as the headline.
// ---------------------------------------------------------------------------
export function ErrorState({
  title, detail, code, onRetry, retryLabel = "Try again",
}: { title: string; detail: string; code?: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="fade-in space-y-3 rounded-2xl border border-danger/40 bg-danger-soft p-5">
      <p className="text-[15px] font-semibold text-danger">{title}</p>
      <p className="text-sm leading-relaxed text-ink-2">{detail}</p>
      <div className="flex flex-wrap items-center gap-3">
        {onRetry ? <Button variant="outline" className="!min-h-9 !py-1.5 text-xs" onClick={onRetry}>{retryLabel}</Button> : null}
        {code ? <code className="font-mono text-[11px] text-ink-3">ref: {code}</code> : null}
      </div>
    </div>
  );
}
