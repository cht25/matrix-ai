"use client";

// IndexedDB offline persistence for QORVYNA:
//   • cached conversations + recent messages (readable while offline)
//   • unsent composer drafts per conversation
//   • outbox retry queue for messages composed offline
// Falls back cleanly to in-memory/no-op if IndexedDB is blocked or SSR.

const DB_NAME = "qorvyna_offline_v1";
const DB_VERSION = 1;
const STORE_CONVERSATIONS = "conversations";
const STORE_DRAFTS = "drafts";
const STORE_OUTBOX = "outbox";
const MAX_CACHED_CONVERSATIONS = 25;

export type CachedMessageItem = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type CachedConversation = {
  id: string;
  title: string;
  mode: string;
  updatedAt: number;
  messages: CachedMessageItem[];
};

export type OfflineDraft = {
  key: string;
  text: string;
  updatedAt: number;
};

export type OutboxItem = {
  id: string;
  conversationId: string | null;
  text: string;
  mode: string;
  createdAt: number;
  status: "queued" | "failed";
};

function openDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          db.createObjectStore(STORE_CONVERSATIONS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          db.createObjectStore(STORE_DRAFTS, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          db.createObjectStore(STORE_OUTBOX, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      let result: T | null = null;
      if (req) {
        req.onsuccess = () => {
          result = req.result;
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        resolve(null);
      };
      tx.onabort = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function saveCachedConversation(entry: CachedConversation): Promise<void> {
  if (!entry.id || !entry.messages.length) return;
  const trimmed: CachedConversation = {
    id: entry.id,
    title: entry.title || "Conversation",
    mode: entry.mode || "general",
    updatedAt: entry.updatedAt || Date.now(),
    messages: entry.messages.slice(-40).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content.slice(0, 12_000),
      created_at: m.created_at,
    })),
  };
  await withStore(STORE_CONVERSATIONS, "readwrite", (store) => store.put(trimmed));
  const all = await listCachedConversations();
  if (all.length > MAX_CACHED_CONVERSATIONS) {
    const stale = all.slice(MAX_CACHED_CONVERSATIONS);
    await withStore(STORE_CONVERSATIONS, "readwrite", (store) => {
      for (const item of stale) store.delete(item.id);
    });
  }
}

export async function listCachedConversations(): Promise<CachedConversation[]> {
  const items = await withStore<CachedConversation[]>(STORE_CONVERSATIONS, "readonly", (store) => store.getAll());
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function getCachedConversation(id: string): Promise<CachedConversation | null> {
  if (!id) return null;
  const item = await withStore<CachedConversation | undefined>(STORE_CONVERSATIONS, "readonly", (store) => store.get(id));
  return item ?? null;
}

export async function saveDraft(key: string, text: string): Promise<void> {
  if (!key) return;
  const trimmed = text.trim();
  if (!trimmed) {
    await clearDraft(key);
    return;
  }
  await withStore(STORE_DRAFTS, "readwrite", (store) =>
    store.put({ key, text, updatedAt: Date.now() } satisfies OfflineDraft),
  );
}

export async function loadDraft(key: string): Promise<string> {
  if (!key) return "";
  const item = await withStore<OfflineDraft | undefined>(STORE_DRAFTS, "readonly", (store) => store.get(key));
  return item?.text ?? "";
}

export async function clearDraft(key: string): Promise<void> {
  if (!key) return;
  await withStore(STORE_DRAFTS, "readwrite", (store) => store.delete(key));
}

export async function enqueueOutboxMessage(item: Omit<OutboxItem, "id" | "createdAt" | "status">): Promise<OutboxItem> {
  const record: OutboxItem = {
    ...item,
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `outbox-${Date.now()}`,
    createdAt: Date.now(),
    status: "queued",
  };
  await withStore(STORE_OUTBOX, "readwrite", (store) => store.put(record));
  return record;
}

export async function listOutboxMessages(): Promise<OutboxItem[]> {
  const items = await withStore<OutboxItem[]>(STORE_OUTBOX, "readonly", (store) => store.getAll());
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeOutboxMessage(id: string): Promise<void> {
  if (!id) return;
  await withStore(STORE_OUTBOX, "readwrite", (store) => store.delete(id));
}
