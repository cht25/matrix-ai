import type { Db } from "@/lib/firebase/admin";

export const projectOwner = { uid: "owner", email: "owner@example.com", emailVerified: true };

/** Serialized in-memory Firestore stand-in with atomic transaction commits. */
export function projectDbFixture(projectId = "p1") {
  const docs = new Map<string, Record<string, unknown>>();
  docs.set(`projects/${projectId}`, { owner_id: projectOwner.uid, title: "Project", revision: 0, file_count: 0, created_at: new Date(), updated_at: new Date() });
  const matches = (name: string) => [...docs.entries()].filter(([key]) => key.startsWith(`${name}/`) && !key.slice(name.length + 1).includes("/"));
  const ref = (path: string) => {
    const self = {
      id: path.split("/").at(-1)!, path,
      get: async () => ({ exists: docs.has(path), id: self.id, ref: self, data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data); },
      delete: async () => { docs.delete(path); },
      collection: (sub: string) => collection(`${path}/${sub}`),
    };
    return self;
  };
  const collection = (name: string) => ({
    doc: (id = `id-${docs.size}-${Math.random().toString(36).slice(2)}`) => ref(`${name}/${id}`),
    add: async (data: Record<string, unknown>) => { const id = `id-${docs.size}`; docs.set(`${name}/${id}`, data); return ref(`${name}/${id}`); },
    get: async () => { const rows = matches(name).map(([key, data]) => ({ id: key.split("/").at(-1)!, ref: ref(key), data: () => data })); return { docs: rows, size: rows.length, empty: !rows.length }; },
    where: (field: string, _op: string, value: unknown) => ({ get: async () => { const rows = matches(name).filter(([, data]) => data[field] === value).map(([key, data]) => ({ id: key.split("/").at(-1)!, ref: ref(key), data: () => data })); return { docs: rows, size: rows.length, empty: !rows.length }; } }),
    listDocuments: async () => matches(name).map(([key]) => ref(key)),
  });
  let lock: Promise<unknown> = Promise.resolve();
  const db = {
    collection,
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
      const next = lock.then(async () => {
        const ops: Array<() => void> = [];
        const tx = {
          get: (target: { get: () => Promise<unknown> }) => target.get(),
          set: (target: ReturnType<typeof ref>, data: Record<string, unknown>, opts?: { merge?: boolean }) => { ops.push(() => { docs.set(target.path, opts?.merge ? { ...docs.get(target.path), ...data } : data); }); },
          delete: (target: ReturnType<typeof ref>) => { ops.push(() => { docs.delete(target.path); }); },
        };
        const result = await fn(tx); for (const op of ops) op(); return result;
      }); lock = next.catch(() => {}); return next;
    },
  } as unknown as Db;
  return { db, docs };
}
