import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

// =============================================================================
// MATRIX design system primitives (spec §52–§53)
// =============================================================================

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary:
      "bg-accent text-white hover:brightness-110 active:brightness-95 shadow-[0_0_0_1px_rgba(255,255,255,0.06)_inset,0_4px_16px_var(--accent-glow)]",
    secondary: "bg-accent-soft text-accent hover:bg-[var(--accent-soft)] hover:brightness-105",
    ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
    danger: "bg-danger text-white hover:brightness-110 active:brightness-95",
    outline: "border border-border-strong bg-surface text-ink hover:border-accent hover:text-ink",
  };
  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50",
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
  return <textarea className={cn("input-base min-h-11 resize-none", className)} {...props} />;
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
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-2">
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
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-full bg-surface-3", className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-all duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Alert({ tone = "info", children }: { tone?: "info" | "success" | "warning" | "danger"; children: ReactNode }) {
  const tones = {
    info: "border-accent/30 bg-accent-soft text-accent",
    success: "border-success/30 bg-success-soft text-success",
    warning: "border-warning/30 bg-warning-soft text-warning",
    danger: "border-danger/30 bg-danger-soft text-danger",
  };
  return <div className={cn("rounded-xl border px-4 py-3 text-sm leading-relaxed", tones[tone])}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
      role="status"
      aria-label="Loading"
    />
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      {icon}
      <p className="font-semibold text-ink">{title}</p>
      {body ? <p className="max-w-sm text-sm text-ink-2">{body}</p> : null}
      {action}
    </div>
  );
}

// --- Dropdown menu -----------------------------------------------------------

export function Menu({ trigger, items }: { trigger: ReactNode; items: { label: string; icon?: ReactNode; danger?: boolean; onClick: () => void }[] }) {
  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{trigger}</summary>
      <div className="card fade-in absolute right-0 z-30 mt-1 w-44 overflow-hidden !rounded-xl !p-1 shadow-[var(--shadow-pop)]">
        {items.map((it, i) => (
          <button
            key={i}
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
