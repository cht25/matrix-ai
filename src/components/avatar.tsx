"use client";

import { cn } from "@/lib/utils";

export function UserAvatar({
  src,
  name,
  size = 32,
  className,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const initial = (name || "U").trim().slice(0, 1).toUpperCase() || "U";
  const dim = `${size}px`;
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-full object-cover ring-1 ring-border", className)}
        style={{ width: dim, height: dim }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full border border-border bg-surface-2 font-semibold text-ink",
        className,
      )}
      style={{ width: dim, height: dim, fontSize: Math.max(11, Math.round(size * 0.36)) }}
    >
      {initial}
    </span>
  );
}
