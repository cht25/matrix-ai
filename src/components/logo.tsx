import Link from "next/link";
import { cn } from "@/lib/utils";

// =============================================================================
// MATRIX brand identity — vector calligraphic wordmark + monogram mark.
// Hand-drawn editorial letterforms (thin strokes, sharp terminals, swash
// baseline). Monochrome by design; adapts to theme via currentColor.
// The same letterform is used for the favicon set (scripts/generate-icons.mjs).
// =============================================================================

export function MatrixMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      <circle cx="20" cy="20" r="18.5" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
      <path
        d="M12 27 V13 L20 22 L28 13 V27"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Calligraphic MATRIX wordmark — the brand signature. */
export function MatrixWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 150 34" fill="none" className={className} aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {/* M */}
        <path d="M2 27 V6 L11.5 20 L21 6 V27" />
        {/* A */}
        <path d="M29.5 27 L38 6 L46.5 27" />
        <path d="M33.5 19.5 L42.5 19.5" />
        {/* T */}
        <path d="M54.5 9 L70.5 9" />
        <path d="M62.5 9 V27" />
        {/* R */}
        <path d="M78 27 V6 L93 6 Q97.5 6 97.5 10 Q97.5 14.5 93 14.5 L78 14.5" />
        <path d="M84.5 14.5 L95.5 27" />
        {/* I */}
        <path d="M107 6 V27" />
        <path d="M103 6 H111" />
        {/* X */}
        <path d="M123 6 L143 27" />
        <path d="M143 6 L123 27" />
      </g>
      {/* Signature swash */}
      <path d="M2 31.5 H126" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.55" />
      <circle cx="138" cy="31.5" r="1.6" fill="currentColor" opacity="0.8" />
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
  const dims = { sm: "h-7 w-7", md: "h-8 w-8", lg: "h-11 w-11" };
  const word = { sm: "h-4 w-16", md: "h-[1.1rem] w-[3.4rem]", lg: "h-6 w-[5.6rem]" };
  return (
    <Link href={href} className={cn("group inline-flex items-center gap-2.5", className)} aria-label="MATRIX home">
      <MatrixMark className={cn(dims[size], "shrink-0 text-ink")} />
      {showWordmark ? <MatrixWordmark className={cn(word[size], "shrink-0 text-ink")} /> : null}
    </Link>
  );
}

/** Vertical brand lockup used on the login page and certificate. */
export function BrandLockup({ className, size = "lg" }: { className?: string; size?: "md" | "lg" }) {
  const mark = size === "lg" ? "h-14 w-14" : "h-10 w-10";
  const word = size === "lg" ? "h-7 w-40" : "h-5 w-28";
  return (
    <div className={cn("flex flex-col items-center gap-4", className)}>
      <MatrixMark className={cn(mark, "text-ink")} />
      <div className="flex flex-col items-center gap-1.5">
        <MatrixWordmark className={cn(word, "text-ink")} />
        <p className="eyebrow">AI Cyber Safety</p>
      </div>
    </div>
  );
}
