// Shared helpers (client + server safe).

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Mirror of the PostgreSQL age calculation used in tests. */
export function calculateAge(dob: Date | string, now: Date = new Date()): number {
  const d = typeof dob === "string" ? new Date(dob) : dob;
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export function riskColor(level: string): string {
  switch (level) {
    case "critical": return "bg-red-100 text-red-700 border-red-200";
    case "high": return "bg-orange-100 text-orange-700 border-orange-200";
    case "medium": return "bg-amber-100 text-amber-700 border-amber-200";
    case "low": return "bg-emerald-100 text-emerald-700 border-emerald-200";
    default: return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

export function scoreLabel(score: number): { label: string; color: string } {
  if (score >= 80) return { label: "Strong", color: "text-emerald-600" };
  if (score >= 60) return { label: "Good", color: "text-teal-600" };
  if (score >= 40) return { label: "Building", color: "text-amber-600" };
  return { label: "Getting started", color: "text-slate-500" };
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export const MIN_AGE = 11;
export const MAX_AGE = 17;

export type AgeValidation =
  | { ok: true; age: number }
  | { ok: false; reason: "DOB_MISSING" | "DOB_FUTURE" | "DOB_TOO_YOUNG" | "DOB_TOO_OLD" };

/** Mirror of the PostgreSQL validate_dob() used by registration (spec §8). */
export function validateAgeForRegistration(dob: string | Date): AgeValidation {
  if (!dob) return { ok: false, reason: "DOB_MISSING" };
  const d = typeof dob === "string" ? new Date(dob) : dob;
  if (Number.isNaN(d.getTime())) return { ok: false, reason: "DOB_MISSING" };
  const now = new Date();
  if (d > now) return { ok: false, reason: "DOB_FUTURE" };
  const age = calculateAge(d, now);
  if (age < MIN_AGE) return { ok: false, reason: "DOB_TOO_YOUNG" };
  if (age > MAX_AGE) return { ok: false, reason: "DOB_TOO_OLD" };
  return { ok: true, age };
}
