import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

// =============================================================================
// MATRIX primitives — restrained, editorial, monochrome (spec §52–§53).
// =============================================================================

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-ink text-bg hover:bg-ink-2 active:bg-ink transition-colors",
    secondary: "bg-surface-2 text-ink hover:bg-surface-3",
    ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
    danger: "bg-danger text-white hover:opacity-90",
    outline: "border border-border-strong bg-surface text-ink hover:border-accent hover:text-accent",
  };
  return (
    <button
      className={cn(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("input-base", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("input-base min-h-10 resize-none", className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn("input-base cursor-pointer", className)} {...props}>
      {children}
    </select>
  );
}

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
        "inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-medium tracking-wide text-ink-2",
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
      className={cn("h-1 w-full overflow-hidden rounded-full bg-surface-3", className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full bg-ink transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
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
  return <div className={cn("rounded-lg border px-4 py-3 text-sm leading-relaxed", tones[tone])}>{children}</div>;
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
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
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
      <div className="card fade-in absolute right-0 z-30 mt-1 w-44 overflow-hidden !rounded-lg !p-1 shadow-[var(--shadow-pop)]">
        {items.map((it, i) => (
          <button
            key={i}
            onClick={it.onClick}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
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
