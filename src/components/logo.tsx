import Link from "next/link";
import { cn } from "@/lib/utils";
import { BRAND_ICON_URL, BRAND_WORDMARK_URL } from "@/lib/brand";

// =============================================================================
// MATRIX brand identity — calligraphic wordmark + monogram mark.
// The artwork is the hosted logo (black ground, electric-blue copperplate
// swashes). Images are blended onto the dark UI so the logo's own black
// canvas disappears into the surface, leaving only the glowing lettering.
// =============================================================================

/** Compact square brand mark (the favicon artwork). */
export function MatrixMark({ className }: { className?: string }) {
  return (
    <span className={cn("brand-mark", className)} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={BRAND_ICON_URL} alt="" className="brand-mark-img" loading="eager" decoding="async" />
    </span>
  );
}

/** Calligraphic MATRIX wordmark — the brand signature. */
export function MatrixWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("brand-wordmark", className)} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={BRAND_WORDMARK_URL} alt="" className="brand-wordmark-img" loading="eager" decoding="async" />
    </span>
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
  const word = { sm: "h-5 w-[4.6rem]", md: "h-6 w-[5.4rem]", lg: "h-9 w-[8rem]" };
  return (
    <Link href={href} className={cn("group inline-flex items-center gap-2.5", className)} aria-label="MATRIX home">
      <MatrixMark className={cn(dims[size], "shrink-0")} />
      {showWordmark ? <MatrixWordmark className={cn(word[size], "shrink-0")} /> : null}
    </Link>
  );
}

/** Vertical brand lockup used on the login page and certificate. */
export function BrandLockup({ className, size = "lg" }: { className?: string; size?: "md" | "lg" }) {
  const mark = size === "lg" ? "h-14 w-14" : "h-10 w-10";
  const word = size === "lg" ? "h-16 w-[17rem]" : "h-11 w-[12rem]";
  return (
    <div className={cn("flex flex-col items-center gap-4", className)}>
      <MatrixMark className={cn(mark, "brand-mark-glow")} />
      <div className="flex flex-col items-center gap-2">
        <MatrixWordmark className={cn(word, "brand-wordmark-glow")} />
        <p className="eyebrow flourish">AI Cyber Safety</p>
      </div>
    </div>
  );
}
