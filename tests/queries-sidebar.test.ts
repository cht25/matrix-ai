import { describe, expect, it } from "vitest";
import { getSidebarData } from "../src/lib/server/queries";

// Regression test for the production incident: GET /chat (and every (app)
// page) 500'd because the sidebar query combined `.where("user_id", "==")`
// with `.orderBy("updated_at")` + two null-filters — a composite query that
// throws "9 FAILED_PRECONDITION: The query requires an index" on any Firebase
// project where firestore.indexes.json has not been deployed. The data layer
// must stay composite-index-free: equality filters only, ordering in memory.
// If anyone reintroduces a composite query here, orderBy() on this fake
// throws and the test fails.

type Call = { method: string; args: unknown[] };

class FakeCollectionQuery {
  readonly calls: Call[] = [];
  private readonly docs: unknown[];

  constructor(docs: unknown[]) {
    this.docs = docs;
  }

  where(...args: unknown[]): this {
    this.calls.push({ method: "where", args });
    return this;
  }

  orderBy(...args: unknown[]): this {
    this.calls.push({ method: "orderBy", args });
    throw new Error(`FAILED_PRECONDITION: the query requires a composite index (${JSON.stringify(args)})`);
  }

  limit(...args: unknown[]): this {
    this.calls.push({ method: "limit", args });
    return this;
  }

  async get(): Promise<{ docs: unknown[] }> {
    this.calls.push({ method: "get", args: [] });
    return { docs: this.docs };
  }

  doc(_id: string) {
    return {
      get: async () => ({ exists: false, data: () => undefined }),
    };
  }
}

const ts = (isoDate: string) => ({ toMillis: () => Date.parse(isoDate), toDate: () => new Date(isoDate) });
const convDoc = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });

function fakeDb(conversations: unknown[]) {
  const queries = new Map<string, FakeCollectionQuery>();
  return {
    queries,
    db: {
      collection: (name: string) => {
        const q = new FakeCollectionQuery(name === "conversations" ? conversations : []);
        queries.set(name, q);
        return q;
      },
    },
  };
}

describe("getSidebarData — composite-index-free (production 500 regression)", () => {
  it("issues equality-only queries (no orderBy/composite index)", async () => {
    const { db, queries } = fakeDb([]);
    const result = await getSidebarData(db as never, "u1");
    expect(result.conversations).toEqual([]);
    const convQuery = queries.get("conversations")!;
    const methods = convQuery.calls.map((c) => c.method);
    expect(methods).not.toContain("orderBy");
    // Every where() is an equality filter on a single field.
    for (const call of convQuery.calls) {
      if (call.method === "where") expect(call.args[1]).toBe("==");
    }
  });

  it("filters deleted/archived in memory, newest first, capped at 100", async () => {
    const docs = [
      convDoc("deleted", { user_id: "u1", title: "x", deleted_at: ts("2026-01-01T00:00:00Z"), archived_at: null, updated_at: ts("2026-08-01T00:00:00Z") }),
      convDoc("archived", { user_id: "u1", title: "y", deleted_at: null, archived_at: ts("2026-01-01T00:00:00Z"), updated_at: ts("2026-08-02T00:00:00Z") }),
      convDoc("temporary", { user_id: "u1", title: "private", is_temporary: true, deleted_at: null, archived_at: null, updated_at: ts("2026-08-03T00:00:00Z") }),
      convDoc("old", { user_id: "u1", title: "old", deleted_at: null, archived_at: null, updated_at: ts("2026-01-01T00:00:00Z") }),
      convDoc("new", { user_id: "u1", title: "new", deleted_at: null, archived_at: null, updated_at: ts("2026-07-01T00:00:00Z") }),
      convDoc("mid", { user_id: "u1", title: "mid", deleted_at: null, archived_at: null, updated_at: ts("2026-05-01T00:00:00Z") }),
    ];
    const { db } = fakeDb(docs);
    const result = await getSidebarData(db as never, "u1");
    expect(result.conversations.map((c) => c.id)).toEqual(["new", "mid", "old"]);
    expect(result.conversations[0].updated_at).toBe("2026-07-01T00:00:00.000Z");
    expect(result.isAdmin).toBe(false);
    expect(result.profileName).toBe("");
  });

  it("treats missing deleted_at/archived_at fields as not deleted/archived", async () => {
    const docs = [convDoc("legacy", { user_id: "u1", title: "legacy", updated_at: ts("2026-06-01T00:00:00Z") })];
    const { db } = fakeDb(docs);
    const result = await getSidebarData(db as never, "u1");
    expect(result.conversations.map((c) => c.id)).toEqual(["legacy"]);
  });
});
