import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

// --- Button ---------------------------------------------------------------
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm",
    secondary: "bg-brand-50 text-brand-700 hover:bg-brand-100",
    ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
    danger: "bg-red-600 text-white hover:bg-red-700",
    outline: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// --- Inputs ---------------------------------------------------------------
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

// --- Form field -------------------------------------------------------------
export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

// --- Card -------------------------------------------------------------------
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm", className)}>{children}</div>
  );
}

// --- Badge ------------------------------------------------------------------
export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

// --- Progress bar ------------------------------------------------------------
export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-slate-200", className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

// --- Alert -------------------------------------------------------------------
export function Alert({ tone = "info", children }: { tone?: "info" | "success" | "warning" | "danger"; children: ReactNode }) {
  const tones = {
    info: "border-brand-200 bg-brand-50 text-brand-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    danger: "border-red-200 bg-red-50 text-red-800",
  };
  return <div className={cn("rounded-xl border px-4 py-3 text-sm", tones[tone])}>{children}</div>;
}

// --- Spinner -----------------------------------------------------------------
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
      role="status"
      aria-label="Loading"
    />
  );
}

// --- Empty state ---------------------------------------------------------------
export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      {icon}
      <p className="font-semibold text-slate-700">{title}</p>
      {body ? <p className="max-w-sm text-sm text-slate-500">{body}</p> : null}
      {action}
    </div>
  );
}
