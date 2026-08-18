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
      <circle cx="20" cy="20" r="18.5" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.5 27.5 V13.5" strokeWidth="2.4" />
        <path d="M12.5 13.5 L20 22" strokeWidth="1.1" />
        <path d="M20 22 L27.5 13.5" strokeWidth="1.1" />
        <path d="M27.5 13.5 V27.5" strokeWidth="2.4" />
      </g>
    </svg>
  );
}

/** Calligraphic MATRIX wordmark — the brand signature.
 *  Hand-lettered structure: heavy downstrokes, hairline diagonals,
 *  serif feet and a signature swash baseline. Monochrome, theme-adaptive. */
export function MatrixWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 150 34" fill="none" className={className} aria-hidden="true">
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {/* M — heavy stems, hairline diagonals, serif feet */}
        <path d="M2.5 6.5 V26.5" strokeWidth="2.5" />
        <path d="M2.5 6.5 L11.5 20" strokeWidth="1.15" />
        <path d="M11.5 20 L20.5 6.5" strokeWidth="1.15" />
        <path d="M20.5 6.5 V26.5" strokeWidth="2.5" />
        <path d="M0.7 26.5 H4.3 M18.7 26.5 H22.3" strokeWidth="1.15" />
        {/* A — hairline left, heavy right, crossbar, foot serifs */}
        <path d="M29.3 26.5 L37.6 6.5" strokeWidth="1.15" />
        <path d="M37.6 6.5 L45.9 26.5" strokeWidth="2.5" />
        <path d="M32.9 20 H42.3" strokeWidth="1.05" />
        <path d="M28.2 26.5 H30.4 M44.8 26.5 H47" strokeWidth="1.05" />
        {/* T — hairline crossbar, heavy stem, foot serifs */}
        <path d="M54.4 8.8 H69.8" strokeWidth="1.25" />
        <path d="M62.1 8.8 V26.5" strokeWidth="2.5" />
        <path d="M60.1 26.5 H64.1" strokeWidth="1.15" />
        {/* R — heavy stem, hairline bowl, hairline leg */}
        <path d="M77.6 26.5 V6.5" strokeWidth="2.5" />
        <path d="M77.6 6.5 H90.9 Q95.6 6.5 95.6 10.2 Q95.6 14.3 91 14.3 H77.6" strokeWidth="1.15" />
        <path d="M83.4 14.3 L94.8 26.5" strokeWidth="1.15" />
        <path d="M75.8 26.5 H79.4" strokeWidth="1.15" />
        {/* I — heavy stem, serifs */}
        <path d="M106.4 6.5 V26.5" strokeWidth="2.4" />
        <path d="M102.8 6.5 H110 M102.8 26.5 H110" strokeWidth="1.15" />
        {/* X — hairline upstroke, heavy downstroke */}
        <path d="M122.6 6.5 L141.2 26.5" strokeWidth="1.15" />
        <path d="M141.2 6.5 L122.6 26.5" strokeWidth="2.5" />
      </g>
      {/* Signature swash baseline + terminal dot */}
      <path d="M2 31.5 H126" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
      <circle cx="137.5" cy="31.5" r="1.7" fill="currentColor" opacity="0.75" />
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
