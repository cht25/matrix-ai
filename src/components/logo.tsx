import Link from "next/link";
import { cn } from "@/lib/utils";

// MATRIX brand: compact mark (shield + network nodes) and wordmark.
// The mark is the same asset used for favicons (scripts/generate-icons.mjs).

export function MatrixMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="mxg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent-2, #4d7cfe)" />
          <stop offset="1" stopColor="var(--accent, #2f5fe0)" />
        </linearGradient>
      </defs>
      {/* Shield */}
      <path
        d="M24 3 42 10v12c0 10.8-7.6 18.6-18 23C13.6 40.6 6 32.8 6 22V10l18-7Z"
        stroke="url(#mxg)"
        strokeWidth="2.6"
        strokeLinejoin="round"
        fill="var(--surface, #0a0d15)"
      />
      {/* Network nodes */}
      <circle cx="17" cy="18" r="2.1" fill="url(#mxg)" />
      <circle cx="24" cy="14" r="2.1" fill="var(--ink-2, #9aa6bf)" />
      <circle cx="31" cy="18" r="2.1" fill="url(#mxg)" />
      <circle cx="24" cy="24" r="2.6" fill="url(#mxg)" />
      <circle cx="17" cy="30" r="2.1" fill="var(--ink-2, #9aa6bf)" />
      <circle cx="31" cy="30" r="2.1" fill="var(--ink-2, #9aa6bf)" />
      {/* Lines */}
      <path
        d="M17 18h14M24 14v10m-7 6 7-6m7 6-7-6"
        stroke="url(#mxg)"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.75"
      />
    </svg>
  );
}

export function Logo({
  size = "md",
  href = "/",
  showWordmark = true,
  className,
}: {
  size?: "sm" | "md" | "lg";
  href?: string;
  showWordmark?: boolean;
  className?: string;
}) {
  const dims = { sm: "h-8 w-8", md: "h-9 w-9", lg: "h-12 w-12" };
  const text = { sm: "text-base", md: "text-lg", lg: "text-2xl" };
  return (
    <Link href={href} className={cn("group inline-flex items-center gap-2.5", className)} aria-label="MATRIX home">
      <MatrixMark className={cn(dims[size], "shrink-0 drop-shadow-[0_0_10px_var(--accent-glow)]")} />
      {showWordmark ? (
        <span className={cn("flex flex-col leading-none", text[size])}>
          <span className="font-extrabold tracking-[0.18em] text-ink">
            MATRIX
          </span>
          <span className="mt-0.5 text-[0.55em] font-semibold uppercase tracking-[0.32em] text-accent">
            AI Cyber Safety
          </span>
        </span>
      ) : null}
    </Link>
  );
}

export function LogoWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-2", className)}>
      <span className="font-extrabold tracking-[0.18em] text-ink">MATRIX</span>
      <span className="rounded-md bg-accent px-1.5 py-0.5 text-[0.6em] font-bold tracking-widest text-white">AI</span>
    </span>
  );
}
