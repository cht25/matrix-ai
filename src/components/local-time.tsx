"use client";

import { useHydrated } from "@/lib/client/use-hydrated";
import { formatDate, timeAgo } from "@/lib/utils";
import { formatUtcShortDate, relativeTime, timeOfDay } from "@/lib/deploy/format";

export function TimeAgoText({ iso }: { iso: string | null | undefined }) {
  const hydrated = useHydrated();
  return <>{hydrated ? timeAgo(iso) : formatDate(iso)}</>;
}

export function RelativeDeployTimeText({
  value,
  empty = "",
}: {
  value: string | number | null | undefined;
  empty?: string;
}) {
  const hydrated = useHydrated();
  if (!value) return <>{empty}</>;
  return <>{hydrated ? relativeTime(value) : formatUtcShortDate(value)}</>;
}

export function TimeOfDayText({ value }: { value: string | number | null | undefined }) {
  const hydrated = useHydrated();
  return <>{hydrated ? timeOfDay(value) : timeOfDay(value, "en-GB", "UTC")}</>;
}

export function LocalDateTimeText({
  value,
  fallback = "Just now",
}: {
  value: string | number | null | undefined;
  fallback?: string;
}) {
  const hydrated = useHydrated();
  if (!value) return <>{fallback}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;
  if (!hydrated) {
    return <>{date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}</>;
  }
  return <>{date.toLocaleString()}</>;
}
