import type { SchedulePreset } from "@/lib/automations";

export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}
function wallParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), wall: Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) };
}

/** Convert an intended local wall time to an instant; reject DST gaps. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): number {
  if (!validTimezone(timeZone) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("SCHEDULE_INVALID");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const intended = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(intended) || new Date(intended).toISOString().slice(0, 10) !== date) throw new Error("SCHEDULE_INVALID");
  let guess = intended;
  for (let i = 0; i < 3; i++) guess += intended - wallParts(guess, timeZone).wall;
  const actual = wallParts(guess, timeZone);
  if (actual.wall !== intended) throw new Error("SCHEDULE_DST_GAP");
  return guess;
}

/** Next strict future occurrence. Weekly repeats on the creation weekday. */
export function nextAutomationRun(options: { preset: SchedulePreset; time: string; timezone: string; weekday: number; after: number }): number {
  const { preset, time, timezone, after } = options;
  if (!Number.isInteger(options.weekday) || options.weekday < 0 || options.weekday > 6) throw new Error("SCHEDULE_INVALID");
  if (preset === "hourly") {
    const minute = Number(time.split(":")[1]);
    if (!validTimezone(timezone) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("SCHEDULE_INVALID");
    const current = wallParts(after, timezone);
    let next = Date.UTC(current.year, current.month - 1, current.day, current.hour, minute);
    next -= next - wallParts(next, timezone).wall;
    if (next <= after) next += 3_600_000;
    return next;
  }
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(after + offset * 86_400_000).toISOString().slice(0, 10);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (preset === "weekly" && weekday !== options.weekday) continue;
    let candidate: number;
    try { candidate = zonedTimeToUtc(date, time, timezone); } catch (error) { if (error instanceof Error && error.message === "SCHEDULE_DST_GAP") continue; throw error; }
    if (candidate > after) return candidate;
  }
  throw new Error("SCHEDULE_NO_OCCURRENCE");
}
