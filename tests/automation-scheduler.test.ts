import { describe, expect, it } from "vitest";
import { nextAutomationRun, zonedTimeToUtc } from "@/lib/automation-schedule";
import { createAutomation, runAutomation, runDueAutomations, listAutomationRuns, setAutomationStatus } from "@/lib/server/automations";
import { Timestamp } from "firebase-admin/firestore";
import type { Db } from "@/lib/firebase/admin";

const user = { uid: "scheduler-owner", email: "owner@example.com", emailVerified: true };
describe("timezone-aware scheduling", () => {
  it("schedules 07:00 Dhaka as 01:00 UTC and strictly advances", () => {
    const after = Date.parse("2026-11-07T00:00:00Z");
    const next = nextAutomationRun({ preset: "daily", time: "07:00", timezone: "Asia/Dhaka", weekday: 6, after });
    expect(new Date(next).toISOString()).toBe("2026-11-07T01:00:00.000Z");
    expect(nextAutomationRun({ preset: "daily", time: "07:00", timezone: "Asia/Dhaka", weekday: 6, after: next })).toBe(next + 86400000);
  });
  it("handles DST boundaries and rejects nonexistent local times", () => {
    expect(new Date(zonedTimeToUtc("2026-03-08", "01:30", "America/New_York")).toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(new Date(zonedTimeToUtc("2026-03-08", "03:30", "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(() => zonedTimeToUtc("2026-03-08", "02:30", "America/New_York")).toThrow("SCHEDULE_DST_GAP");
    expect(() => zonedTimeToUtc("2026-11-07", "07:00", "Invalid/Zone")).toThrow();
  });
  it("hourly uses the selected minute; weekly repeats on its anchor weekday", () => {
    const after = Date.parse("2026-11-07T02:20:00Z");
    expect(new Date(nextAutomationRun({ preset: "hourly", time: "07:15", timezone: "UTC", weekday: 6, after })).toISOString()).toBe("2026-11-07T03:15:00.000Z");
    const weekly = nextAutomationRun({ preset: "weekly", time: "07:00", timezone: "UTC", weekday: 1, after });
    expect(new Date(weekly).toISOString()).toBe("2026-11-09T07:00:00.000Z");
  });
});

function fixture() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({ id: path.split("/").at(-1)!, get: async () => ({ exists: docs.has(path), id: path.split("/").at(-1)!, data: () => docs.get(path), ref: ref(path) }), set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data); } });
  const collection = (name: string) => {
    const query = (filters: [string, string, unknown][] = [], limit = 100) => ({
      where: (field: string, op: string, value: unknown) => query([...filters, [field, op, value]], limit), limit: (n: number) => query(filters, n),
      get: async () => ({ docs: [...docs.entries()].filter(([key, data]) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes("/") && filters.every(([field, op, value]) => op === "==" ? data[field] === value : op === "<=" ? Number((data[field] as Timestamp | undefined)?.toMillis?.() ?? Infinity) <= (value as Timestamp).toMillis() : true)).slice(0, limit).map(([key, data]) => ({ id: key.split("/").at(-1)!, data: () => data })) }),
    });
    return { ...query(), doc: (id = `id-${docs.size}-${Math.random().toString(36).slice(2)}`) => ref(`${name}/${id}`), add: async (data: Record<string, unknown>) => { const id = `id-${docs.size}`; docs.set(`${name}/${id}`, data); return { id }; } };
  };
  let lock: Promise<unknown> = Promise.resolve();
  const db = { collection, runTransaction: (fn: (tx: unknown) => Promise<unknown>) => { const next = lock.then(() => fn({ get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, data: Record<string, unknown>, opts?: { merge?: boolean }) => r.set(data, opts) })); lock = next.catch(() => {}); return next; } } as unknown as Db;
  return { db, docs };
}

describe("durable scheduler execution", () => {
  it("runs only due active workflows, claims once, and creates a real notification", async () => {
    const { db, docs } = fixture();
    const automation = await createAutomation(db, user, { name: "Morning notification", trigger: "schedule", schedule: "daily", time: "07:00", timezone: "UTC", actions: [{ tool: "notifications.create", args: { title: "Morning", body: "Workflow executed", link: "/automations" } }] });
    const path = [...docs.keys()].find((key) => key.startsWith("automations/") && docs.get(key)?.name === "Morning notification")!;
    const due = Date.parse("2026-11-07T07:00:00Z");
    docs.get(path!)!.next_run_at = Timestamp.fromMillis(due);
    const results = await Promise.allSettled([runDueAutomations(db, { nowMs: due, resolveUser: async () => user }), runDueAutomations(db, { nowMs: due, resolveUser: async () => user })]);
    const outcomes = results.flatMap((result) => result.status === "fulfilled" ? result.value.outcomes : []);
    expect(outcomes.filter((item) => item.ok)).toHaveLength(1);
    expect([...docs.values()].filter((data) => data.type === "automation" && data.title === "Morning")).toHaveLength(1);
    expect(docs.get(path!)!.run_count).toBe(1);
    expect((docs.get(path!)!.next_run_at as Timestamp).toMillis()).toBe(due + 86400000);
    expect((await listAutomationRuns(db, user, automation.id))[0].ok).toBe(true);
    await setAutomationStatus(db, user, automation.id, "paused");
    docs.get(path!)!.next_run_at = Timestamp.fromMillis(due);
    expect((await runDueAutomations(db, { nowMs: due, resolveUser: async () => user })).attempted).toBe(0);
  });
  it("records failed actions without claiming success", async () => {
    const { db } = fixture();
    const automation = await createAutomation(db, user, { name: "Missing project", trigger: "manual", actions: [{ tool: "projects.get", args: { project_id: "missing" } }] });
    const result = await runAutomation(db, user, automation.id);
    expect(result.ok).toBe(false);
    expect((await listAutomationRuns(db, user, automation.id))[0].status).toBe("failed");
  });
});
