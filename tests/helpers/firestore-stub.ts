// Minimal in-memory Firestore stub for the operations the AI gateway route
// performs, with fault injection so integration tests can simulate real
// production failures (write quota exhaustion, transient read errors…).
import { vi } from "vitest";

export type FirestoreFault = {
  /** Match by collection name, or "*" for any. */
  collection: string;
  /** Match by method: "add" | "create" | "set" | "get" | "count" */
  method?: string;
  error: Error;
  times?: number;
};

type DocRecord = Record<string, unknown>;

export function createFirestoreStub() {
  const state = {
    docs: new Map<string, DocRecord>(),
    faults: [] as FirestoreFault[],
    calls: [] as { collection: string; method: string; doc?: string }[],
  };

  function nextId(): string {
    return `id_${Math.random().toString(36).slice(2, 12)}`;
  }

  function takeFault(collection: string, method: string): Error | null {
    const index = state.faults.findIndex(
      (f) => (f.collection === collection || f.collection === "*") && (!f.method || f.method === method),
    );
    if (index === -1) return null;
    const fault = state.faults[index];
    if (fault.times !== undefined) {
      if (fault.times <= 0) {
        state.faults.splice(index, 1);
        return null;
      }
      fault.times -= 1;
    }
    return fault.error;
  }

  function collection(name: string) {
    const whereClauses: { field: string; op: string; value: unknown }[] = [];
    let limitCount: number | null = null;

    const self = {
      doc: (docId: string) => makeDocRef(name, docId),
      add: async (data: DocRecord) => {
        state.calls.push({ collection: name, method: "add" });
        const fault = takeFault(name, "add");
        if (fault) throw fault;
        const id = nextId();
        state.docs.set(`${name}/${id}`, structuredClone(data));
        return { id };
      },
      where: (field: string, op: string, value: unknown) => {
        whereClauses.push({ field, op, value });
        return self;
      },
      limit: (n: number) => {
        limitCount = n;
        return self;
      },
      count: () => ({
        get: async () => {
          state.calls.push({ collection: name, method: "count" });
          const fault = takeFault(name, "count");
          if (fault) throw fault;
          const count = [...state.docs.keys()].filter((k) => k.startsWith(`${name}/`)).length;
          return { data: () => ({ count }) };
        },
      }),
      get: async () => {
        state.calls.push({ collection: name, method: "get" });
        const fault = takeFault(name, "get");
        if (fault) throw fault;
        let docs = [...state.docs.entries()]
          .filter(([k]) => k.startsWith(`${name}/`) && !k.slice(name.length + 1).includes("/"))
          .map(([k, data]) => ({ id: k.slice(name.length + 1), data: () => data, exists: true }));
        for (const clause of whereClauses) {
          docs = docs.filter((d) => {
            const value = (d.data() as Record<string, unknown>)[clause.field];
            if (clause.op === "==") return value === clause.value;
            if (clause.op === "in") return Array.isArray(clause.value) && (clause.value as unknown[]).includes(value);
            return true;
          });
        }
        if (limitCount !== null) docs = docs.slice(0, limitCount);
        return { empty: docs.length === 0, docs, size: docs.length };
      },
    };
    return self;
  }

  function makeDocRef(name: string, docId: string) {
    const path = `${name}/${docId}`;
    const self = {
      id: docId,
      get: async () => {
        state.calls.push({ collection: name, method: "get", doc: docId });
        const fault = takeFault(name, "get");
        if (fault) throw fault;
        const data = state.docs.get(path);
        return { exists: data !== undefined, data: () => (data ? structuredClone(data) : undefined), id: docId };
      },
      create: async (data: DocRecord) => {
        state.calls.push({ collection: name, method: "create", doc: docId });
        const fault = takeFault(name, "create");
        if (fault) throw fault;
        if (state.docs.has(path)) {
          const err = new Error("already exists");
          (err as { code?: string }).code = "6";
          throw err;
        }
        state.docs.set(path, structuredClone(data));
        return { id: docId };
      },
      set: async (data: DocRecord, _opts?: { merge?: boolean }) => {
        state.calls.push({ collection: name, method: "set", doc: docId });
        const fault = takeFault(name, "set");
        if (fault) throw fault;
        const existing = state.docs.get(path) ?? {};
        state.docs.set(path, { ...existing, ...structuredClone(data) });
        return self;
      },
      collection: (sub: string) => collection(`${name}/${docId}/placeholders_${sub}` === "" ? sub : `${sub}__under_${name}/${docId}`),
    };
    // Subcollections (conversations/{id}/messages) are modelled as their own
    // top-level namespace keyed by the full path, which the chat route only
    // ever reads back through the same path.
    self.collection = (sub: string) => collection(`${name}/${docId}/${sub}`);
    return self;
  }

  return {
    _state: state,
    collection,
    fault: (f: FirestoreFault) => state.faults.push(f),
    clearFaults: () => (state.faults.length = 0),
    dump: () => Object.fromEntries(state.docs),
  };
}

export type FirestoreStub = ReturnType<typeof createFirestoreStub>;

let shared: FirestoreStub | null = null;
/** One stub instance shared between the vi.mock factory and the test body. */
export function sharedFirestoreStub(): FirestoreStub {
  if (!shared) shared = createFirestoreStub();
  return shared;
}

export function makeAdminModule(stub: FirestoreStub) {
  const fixedUser = { uid: "probe-user-1", email: "probe@example.com", email_verified: true };
  return {
    adminDb: vi.fn(() => stub),
    adminAuth: vi.fn(() => ({
      verifyIdToken: vi.fn(async () => fixedUser),
      verifySessionCookie: vi.fn(async () => fixedUser),
      createSessionCookie: vi.fn(async () => "stub-session-cookie"),
    })),
    nowTs: () => Date.now(),
    Timestamp: { now: () => Date.now() },
  };
}
