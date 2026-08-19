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

/** Milliseconds for Firestore Timestamps / Dates / ISO strings (0 when absent). */
export function millis(value: unknown): number {
  const ts = value as { toMillis?: () => number; toDate?: () => Date } | null | undefined;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  if (ts && typeof ts.toDate === "function") return ts.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
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
