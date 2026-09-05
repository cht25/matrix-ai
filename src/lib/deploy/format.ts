// =============================================================================
// Deployment display helpers — pure, shared by chat, the project workspace and
// the admin site list.
// =============================================================================

export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/** "Just now · 12 min ago · 1 hour ago · Yesterday · Mar 4" */
export function relativeTime(value: string | number | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** HH:MM:SS for log rows (the stored value is a full ISO timestamp). */
export function timeOfDay(value: string | number | null | undefined, locale = "en-GB"): string {
  if (!value) return "";
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) return "";
  return new Date(at).toLocaleTimeString(locale, { hour12: false });
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}

/** Display-friendly URL: no protocol noise, never an empty string. */
export function shortUrl(url: string | null | undefined, limit = 52): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  const bare = value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return bare.length > limit ? `${bare.slice(0, limit - 1)}…` : bare;
}

/**
 * Resolve a stored URL against the current origin. MATRIX keeps generated
 * addresses as `/s/<slug>` so they keep working on preview, Render and the
 * production apex without a rebuild — the browser fills in the real host.
 */
export function absoluteUrl(url: string | null | undefined): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (typeof window === "undefined") return value;
  try {
    return new URL(value, window.location.origin).toString();
  } catch {
    return value;
  }
}

export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value, "http://localhost");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Clipboard write with a documented fallback for non-secure contexts. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
