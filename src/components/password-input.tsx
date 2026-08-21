"use client";

import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

/** Password field with an accessible visibility toggle. */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function PasswordInput(
  { className, id, ...props },
  ref,
) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        ref={ref}
        id={id}
        type={show ? "text" : "password"}
        className={cn("input-base pr-11", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        className="absolute inset-y-0 right-0 grid w-11 place-items-center text-ink-3 transition-colors hover:text-ink"
      >
        {show ? <EyeOff size={16} strokeWidth={1.7} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.7} aria-hidden="true" />}
      </button>
    </div>
  );
});
