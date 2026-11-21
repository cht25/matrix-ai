// In-memory sort/filter helpers for server-side Firestore reads.
//
// The data layer deliberately uses equality-only Firestore queries and does
// ordering, null-filtering and limiting here instead of at the database.
// Equality-only filters are served by the automatic single-field indexes
// (merged by Firestore), so the app works on a brand-new Firebase project
// before anyone runs `firebase deploy --only firestore:indexes`. A missing
// composite index previously crashed every server-rendered page with
// "9 FAILED_PRECONDITION: The query requires an index" (a 500 in production);
// firestore.indexes.json remains for optional, larger-scale deployments.
//
// Ordering semantics match Firestore's: values compare numerically when both
// sides are numbers, chronologically for Timestamps/Dates/ISO strings, and by
// string order otherwise. Documents MISSING the sort field sort last instead
// of being dropped (Firestore omits them entirely); every writer in this
// codebase sets the sort fields explicitly, so this only affects legacy or
// hand-edited documents — showing them degraded is safer than hiding them.

/** Structural type so this module works with any Firestore snapshot shape. */
export type ReadableDoc = { id: string; data(): Record<string, any> };

const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Bounded, exception-safe epoch-millisecond converter for Firestore Timestamps,
 * serialized {_seconds, _nanoseconds} objects, Dates, ISO strings, and numbers.
 * Returns 0 for absent, NaN, or out-of-range values so Date.toISOString() never throws.
 */
export function safeMillis(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? value : 0;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && Math.abs(t) <= MAX_DATE_MS ? t : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_DATE_MS ? parsed : 0;
  }
  if (typeof value === "object") {
    const ts = value as {
      toMillis?: () => number;
      toDate?: () => Date;
      _seconds?: number;
      _nanoseconds?: number;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof ts.toMillis === "function") {
      try {
        const ms = Number(ts.toMillis());
        return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : 0;
      } catch {
        return 0;
      }
    }
    if (typeof ts.toDate === "function") {
      try {
        const t = ts.toDate().getTime();
        return Number.isFinite(t) && Math.abs(t) <= MAX_DATE_MS ? t : 0;
      } catch {
        return 0;
      }
    }
    const secs = typeof ts._seconds === "number" ? ts._seconds : typeof ts.seconds === "number" ? ts.seconds : null;
    if (secs !== null && Number.isFinite(secs)) {
      const nanos =
        typeof ts._nanoseconds === "number"
          ? ts._nanoseconds
          : typeof ts.nanoseconds === "number"
            ? ts.nanoseconds
            : 0;
      const ms = secs * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1_000_000);
      return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : 0;
    }
  }
  return 0;
}

/** Safe ISO-8601 string serializer for Firestore timestamp-like values ("" when absent/invalid). */
export function safeIso(value: unknown): string {
  const ms = safeMillis(value);
  if (!ms) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

/** Milliseconds for Firestore Timestamps / Dates / ISO strings (0 when absent). */
export function millis(value: unknown): number {
  return safeMillis(value);
}

function isTimeLike(value: unknown): boolean {
  const ts = value as { toMillis?: () => number; toDate?: () => Date } | null | undefined;
  return Boolean(ts && (typeof ts.toMillis === "function" || typeof ts.toDate === "function")) || value instanceof Date;
}

/** Generic ascending field comparator (missing values sort last). */
export function compareValues(x: unknown, y: unknown): number {
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (isTimeLike(x) || isTimeLike(y)) return millis(x) - millis(y);
  const sx = String(x);
  const sy = String(y);
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

/** Ascending comparator over a document field. */
export function ascDoc<T extends ReadableDoc>(field: string): (a: T, b: T) => number {
  return (a, b) => compareValues(a.data()[field], b.data()[field]);
}

/** Descending comparator over a document field (missing values still sort last). */
export function descDoc<T extends ReadableDoc>(field: string): (a: T, b: T) => number {
  return (a, b) => {
    const x = a.data()[field];
    const y = b.data()[field];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return compareValues(y, x);
  };
}

/** Firestore `where(field, "==", null)` equivalent; a missing field counts as null. */
export function isNullish(value: unknown): boolean {
  return value == null;
}
