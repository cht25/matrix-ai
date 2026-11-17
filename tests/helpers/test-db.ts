// Shared in-memory Firestore helper for Vitest unit/integration suites.
// Preserves Timestamp / Date instances (unlike raw structuredClone) and supports
// collections, subcollections, where/orderBy/limit, delete, and transactions.
type DocData = Record<string, unknown>;

function cloneValue(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (val instanceof Date) return new Date(val.getTime());
  if (typeof (val as { toMillis?: unknown }).toMillis === "function") return val;
  if (Array.isArray(val)) return val.map(cloneValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = cloneValue(v);
  }
  return out;
}

function cloneDoc(data: DocData): DocData {
  return cloneValue(data) as DocData;
}

export function makeFakeFirestore() {
  const docs = new Map<string, DocData>();
  let seq = 0;

  function makeRef(colPath: string, id: string) {
    const key = `${colPath}/${id}`;
    const ref = {
      id,
      get: async () => ({
        id,
        exists: docs.has(key),
        data: () => (docs.has(key) ? cloneDoc(docs.get(key)!) : undefined),
        ref,
      }),
      set: async (data: DocData, opts?: { merge?: boolean }) => {
        docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...cloneDoc(data) } : cloneDoc(data));
        return ref;
      },
      update: async (data: DocData) => {
        docs.set(key, { ...(docs.get(key) ?? {}), ...cloneDoc(data) });
        return ref;
      },
      delete: async () => {
        docs.delete(key);
      },
      collection: (sub: string) => makeCollection(`${colPath}/${id}/${sub}`),
    };
    return ref;
  }

  function makeCollection(colPath: string) {
    const filters: Array<{ field: string; op: string; value: unknown }> = [];
    let orderField: string | null = null;
    let orderDir: "asc" | "desc" = "asc";
    let maxRows: number | null = null;

    const col = {
      doc: (id?: string) => makeRef(colPath, id ?? `doc_${String(++seq).padStart(6, "0")}`),
      add: async (data: DocData) => {
        const id = `doc_${String(++seq).padStart(6, "0")}`;
        docs.set(`${colPath}/${id}`, cloneDoc(data));
        return makeRef(colPath, id);
      },
      where: (field: string, op: string, value: unknown) => {
        filters.push({ field, op, value });
        return col;
      },
      orderBy: (field: string, dir: "asc" | "desc" = "asc") => {
        orderField = field;
        orderDir = dir;
        return col;
      },
      limit: (n: number) => {
        maxRows = n;
        return col;
      },
      get: async () => {
        let rows = [...docs.entries()]
          .filter(([k]) => k.startsWith(`${colPath}/`) && !k.slice(colPath.length + 1).includes("/"))
          .map(([k, v]) => {
            const id = k.slice(colPath.length + 1);
            return {
              id,
              exists: true,
              data: () => cloneDoc(v),
              ref: makeRef(colPath, id),
            };
          });

        for (const f of filters) {
          rows = rows.filter((r) => {
            const val = r.data()[f.field];
            if (f.op === "==") return val === f.value;
            if (f.op === "in") return Array.isArray(f.value) && f.value.includes(val);
            return true;
          });
        }

        if (orderField) {
          const field = orderField;
          const dir = orderDir === "desc" ? -1 : 1;
          rows.sort((a, b) => {
            const av = a.data()[field];
            const bv = b.data()[field];
            return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
          });
        }

        if (maxRows !== null) rows = rows.slice(0, maxRows);
        return { empty: rows.length === 0, size: rows.length, docs: rows };
      },
    };
    return col;
  }

  return {
    collection: (name: string) => makeCollection(name),
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: (r: { get: () => Promise<unknown> }) => r.get(),
        set: (r: { set: (d: DocData, o?: { merge?: boolean }) => Promise<unknown> }, data: DocData, opts?: { merge?: boolean }) =>
          void r.set(data, opts),
      }),
    dump: (colPath: string): Record<string, DocData> => {
      const out: Record<string, DocData> = {};
      for (const [k, v] of docs.entries()) {
        if (k.startsWith(`${colPath}/`) && !k.slice(colPath.length + 1).includes("/")) {
          out[k.slice(colPath.length + 1)] = cloneDoc(v);
        }
      }
      return out;
    },
  };
}
