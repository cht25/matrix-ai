import { describe, expect, it } from "vitest";
import { ascDoc, compareValues, descDoc, millis, type ReadableDoc } from "../src/lib/server/sort";

// Lightweight stand-ins for Firestore document snapshots.
const doc = (id: string, data: Record<string, any>): ReadableDoc => ({ id, data: () => data });
// Stand-in for a Firestore Timestamp.
const ts = (isoDate: string) => ({ toMillis: () => Date.parse(isoDate), toDate: () => new Date(isoDate) });

describe("server sort helpers (index-free Firestore reads)", () => {
  it("millis handles Timestamps, Dates and ISO strings", () => {
    expect(millis(ts("2026-01-02T03:04:05Z"))).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(millis(new Date("2026-01-02T03:04:05Z"))).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(millis("2026-01-02T03:04:05Z")).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(millis(undefined)).toBe(0);
    expect(millis("not-a-date")).toBe(0);
  });

  it("descDoc orders timestamp fields newest-first (sidebar semantics)", () => {
    const rows = [
      doc("old", { updated_at: ts("2026-01-01T00:00:00Z") }),
      doc("new", { updated_at: ts("2026-08-01T00:00:00Z") }),
      doc("mid", { updated_at: ts("2026-05-01T00:00:00Z") }),
    ];
    expect(rows.sort(descDoc("updated_at")).map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("ascDoc orders numeric fields ascending (sort_order semantics)", () => {
    const rows = [doc("b", { sort_order: 2 }), doc("c", { sort_order: 10 }), doc("a", { sort_order: 1 })];
    expect(rows.sort(ascDoc("sort_order")).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("ascDoc orders string fields (title/organization semantics)", () => {
    const rows = [doc("2", { title: "Phishing" }), doc("1", { title: "Bank scams" }), doc("3", { title: "romance" })];
    expect(rows.sort(ascDoc("title")).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("documents missing the sort field sort last instead of being dropped", () => {
    const rows = [doc("missing", {}), doc("b", { created_at: ts("2026-02-01T00:00:00Z") }), doc("a", { created_at: ts("2026-01-01T00:00:00Z") })];
    expect(rows.sort(ascDoc("created_at")).map((r) => r.id)).toEqual(["a", "b", "missing"]);
    expect(rows.sort(descDoc("created_at")).map((r) => r.id)).toEqual(["b", "a", "missing"]);
  });

  it("compareValues mixes Timestamp and ISO-string chronologically", () => {
    expect(compareValues(ts("2026-01-02T00:00:00Z"), "2026-01-03T00:00:00Z")).toBeLessThan(0);
    expect(compareValues("2026-01-03T00:00:00Z", ts("2026-01-02T00:00:00Z"))).toBeGreaterThan(0);
  });
});
