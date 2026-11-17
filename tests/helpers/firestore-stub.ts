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

  /** Compare numbers and Firestore-like timestamps. */
  function toComparable(value: unknown): number {
    if (typeof value === "number") return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const ts = value as { toMillis?: () => number; _seconds?: number } | null | undefined;
    if (typeof ts?.toMillis === "function") return ts.toMillis();
    if (typeof ts?._seconds === "number") return ts._seconds * 1000;
    return 0;
  }

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
      // Like Firestore: `doc()` with no id allocates one.
      doc: (docId?: string) => makeDocRef(name, docId ?? nextId()),
      add: async (data: DocRecord) => {
        state.calls.push({ collection: name, method: "add" });
        const fault = takeFault(name, "add");
        if (fault) throw fault;
        const id = nextId();
        state.docs.set(`${name}/${id}`, structuredClone(data));
        // Like Firestore: `add` resolves to the new document's reference.
        return makeDocRef(name, id);
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
          .map(([k, data]) => ({ id: k.slice(name.length + 1), data: () => data, exists: true, ref: makeDocRef(name, k.slice(name.length + 1)) }));
        for (const clause of whereClauses) {
          docs = docs.filter((d) => {
            // Firestore supports dotted field paths (`a.uid`) — resolve them
            // rather than silently matching every document.
            const value = clause.field
              .split(".")
              .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | null)?.[part], d.data());
            switch (clause.op) {
              case "==":
                return value === clause.value;
              case "!=":
                return value !== clause.value;
              case "in":
                return Array.isArray(clause.value) && (clause.value as unknown[]).includes(value);
              case ">=":
                return toComparable(value) >= toComparable(clause.value);
              case "<=":
                return toComparable(value) <= toComparable(clause.value);
              case ">":
                return toComparable(value) > toComparable(clause.value);
              case "<":
                return toComparable(value) < toComparable(clause.value);
              default:
                return false;
            }
          });
        }
        if (limitCount !== null) docs = docs.slice(0, limitCount);
        return { empty: docs.length === 0, docs, size: docs.length };
      },
      listDocuments: async () => [...state.docs.keys()]
        .filter((k) => k.startsWith(`${name}/`) && !k.slice(name.length + 1).includes("/"))
        .map((k) => makeDocRef(name, k.slice(name.length + 1))),
    };
    return self;
  }

  function makeDocRef(name: string, docId: string) {
    const path = `${name}/${docId}`;
    const self = {
      id: docId,
      /** Full collection path — used by the transaction implementation. */
      path,
      get: async () => {
        state.calls.push({ collection: name, method: "get", doc: docId });
        const fault = takeFault(name, "get");
        if (fault) throw fault;
        const data = state.docs.get(path);
        return { exists: data !== undefined, data: () => (data ? structuredClone(data) : undefined), id: docId, ref: self };
      },
      delete: async () => {
        state.calls.push({ collection: name, method: "delete", doc: docId });
        state.docs.delete(path);
      },
      update: async (data: DocRecord) => {
        state.calls.push({ collection: name, method: "update", doc: docId });
        state.docs.set(path, { ...(state.docs.get(path) ?? {}), ...structuredClone(data) });
        return self;
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

  /**
   * Transactions. The stub applies writes immediately (like the emulator) but
   * runs reads-before-writes in the caller's order and rolls back every write
   * recorded so far when the callback throws — so "single use" logic that
   * relies on a transaction is exercised, not bypassed.
   */
  async function runTransaction<T>(fn: (tx: {
    get: (ref: { id: string; path?: string }) => Promise<{ exists: boolean; data: () => DocRecord | undefined; id: string }>;
    set: (ref: { id: string; path?: string }, data: DocRecord, options?: { merge?: boolean }) => void;
    update: (ref: { id: string; path?: string }, data: DocRecord) => void;
    delete: (ref: { id: string; path?: string }) => void;
  }) => Promise<T> | T): Promise<T> {
    const pending: Array<{ key: string; data: DocRecord; merge: boolean } | { key: string; remove: true }> = [];
    const tx = {
      get: async (ref: { id: string; path?: string }) => {
        const key = (ref as { path?: string }).path ?? String(ref.id);
        const data = state.docs.get(key);
        return { exists: data !== undefined, data: () => (data ? structuredClone(data) : undefined), id: ref.id };
      },
      set: (ref: { id: string; path?: string }, data: DocRecord, options?: { merge?: boolean }) => {
        const key = (ref as { path?: string }).path ?? String(ref.id);
        pending.push({ key, data: structuredClone(data), merge: options?.merge === true });
      },
      update: (ref: { id: string; path?: string }, data: DocRecord) => {
        const key = (ref as { path?: string }).path ?? String(ref.id);
        pending.push({ key, data: structuredClone(data), merge: true });
      },
      delete: (ref: { id: string; path?: string }) => {
        const key = (ref as { path?: string }).path ?? String(ref.id);
        pending.push({ key, remove: true });
      },
    };
    try {
      const result = await fn(tx);
      for (const write of pending) {
        if ("remove" in write) {
          state.docs.delete(write.key);
          continue;
        }
        const previous = write.merge ? state.docs.get(write.key) ?? {} : {};
        state.docs.set(write.key, { ...previous, ...write.data });
      }
      return result;
    } catch (error) {
      pending.length = 0; // rolled back: nothing is applied
      throw error;
    }
  }

  return {
    _state: state,
    collection,
    runTransaction,
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
    Timestamp: {
      now: () => Date.now(),
      fromMillis: (ms: number) => ms,
      fromDate: (date: Date) => date.getTime(),
    },
  };
}
