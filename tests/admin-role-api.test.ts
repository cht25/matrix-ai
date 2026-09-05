// End-to-end test of the real /api/rpc route handler:
//   frontend payload → HTTP → session auth → authorization → role validation
//   → in-memory Firestore → response envelope → client error mapping.
//
// Only Firebase itself is doubled; the routing, auth gate, Zod parsing,
// canonical role validation, audit write and response shaping are the real
// production code paths.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapAdminError } from "../src/lib/admin-errors";

type Doc = Record<string, unknown>;
const store: Record<string, Record<string, Doc>> = {};
const added: Doc[] = [];
const claims: Record<string, unknown> = {};
let sessionUid: string | null = "actor-super";

function col(name: string) { return (store[name] ??= {}); }

const fakeDb = {
  collection(name: string) {
    const api = {
      doc(id: string) {
        return {
          async get() { const data = col(name)[id]; return { exists: data !== undefined, id, data: () => data }; },
          async set(v: Doc, o?: { merge?: boolean }) { col(name)[id] = o?.merge ? { ...(col(name)[id] ?? {}), ...v } : v; },
          async delete() { delete col(name)[id]; },
        };
      },
      async add(v: Doc) { added.push({ collection: name, ...v }); return { id: `gen-${added.length}` }; },
      async get() {
        const docs = Object.entries(col(name)).map(([id, data]) => ({ id, data: () => data }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
      limit() { return api; },
      orderBy() { return api; },
      where(_f: string, _op: string, value: unknown) {
        return {
          async get() {
            const docs = Object.entries(col(name))
              .filter(([, d]) => (d as Record<string, unknown>).role_id === value)
              .map(([id, data]) => ({ id, data: () => data }));
            return { docs, empty: docs.length === 0, size: docs.length };
          },
        };
      },
    };
    return api;
  },
};

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => fakeDb,
  nowTs: () => "TS",
  toTs: (v: unknown) => v,
  adminConfigured: () => true,
}));
vi.mock("@/lib/firebase/session", () => ({
  getSessionUser: async () => (sessionUid ? { uid: sessionUid, email: `${sessionUid}@matrix.test` } : null),
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    async setCustomUserClaims(uid: string, v: unknown) { claims[uid] = v; },
    async updateUser() { return {}; },
    async revokeRefreshTokens() {},
    async listUsers() { return { users: [] }; },
    async getUser() { return null; },
  }),
}));

const { POST } = await import("../src/app/api/rpc/route");

/** Exactly what the admin Role Editor sends. */
async function call(action: string, args: Record<string, unknown> = {}) {
  const req = new Request("http://localhost/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...args }),
  });
  const res = await POST(req as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  added.length = 0;
  sessionUid = "actor-super";
  store.admin_role_assignments = { "actor-super": { role_id: "super_admin" } };
  store.profiles = { alex: { email: "alex@matrix.test", full_name: "Alex", created_at: null } };
});

describe("POST /api/rpc admin_set_role", () => {
  it("USER → ADMIN succeeds and persists (survives a page refresh)", async () => {
    const r = await call("admin_set_role", { uid: "alex", role: "security_admin" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, data: { uid: "alex", role: "security_admin" } });

    // "Refresh the page": re-read the list the way the Users page does.
    const list = await call("admin_list_users");
    const alex = (list.body.data as { id: string; admin_role: string | null }[]).find((u) => u.id === "alex");
    expect(alex?.admin_role).toBe("security_admin");
  });

  it("ADMIN → USER (revoke) succeeds and persists", async () => {
    await call("admin_set_role", { uid: "alex", role: "super_admin" });
    const r = await call("admin_set_role", { uid: "alex", role: "none" });
    expect(r.status).toBe(200);
    expect(store.admin_role_assignments.alex).toBeUndefined();
    expect(claims.alex).toEqual({ admin: false });

    const list = await call("admin_list_users");
    const alex = (list.body.data as { id: string; admin_role: string | null }[]).find((u) => u.id === "alex");
    expect(alex?.admin_role).toBeNull();
  });

  it("every canonical role offered by the selector is accepted by the backend", async () => {
    const catalog = await call("admin_role_catalog");
    const roles = (catalog.body.data as { roles: { id: string }[] }).roles;
    expect(roles.length).toBe(5);
    for (const role of roles) {
      const r = await call("admin_set_role", { uid: "alex", role: role.id });
      expect(r.status, `role ${role.id} must be accepted`).toBe(200);
    }
  });

  it("an invalid role is rejected by the backend with a mappable code", async () => {
    const r = await call("admin_set_role", { uid: "alex", role: "wizard" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, error: { code: "ROLE_INVALID" } });

    // The UI never renders the raw code as its headline.
    const view = mapAdminError((r.body.error as { code: string }).code);
    expect(view.title).toBe("Unable to update role");
    expect(view.detail).toBe("The selected role is not supported by the current system configuration.");
  });

  it("a non-admin cannot perform the mutation", async () => {
    sessionUid = "regular-user";
    const r = await call("admin_set_role", { uid: "alex", role: "auditor" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    expect(store.admin_role_assignments.alex).toBeUndefined();
  });

  it("an unauthenticated request is rejected before any handler runs", async () => {
    sessionUid = null;
    const r = await call("admin_set_role", { uid: "alex", role: "auditor" });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("a role sent as an object (not a string) is rejected as a bad request, not a crash", async () => {
    const r = await call("admin_set_role", { uid: "alex", role: { id: "super_admin" } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, error: { code: "BAD_REQUEST" } });
  });

  it("writes an audit entry readable by the Audit Logs page", async () => {
    await call("admin_set_role", { uid: "alex", role: "support_admin" });
    await call("admin_set_role", { uid: "alex", role: "auditor" });
    const logs = added.filter((a) => a.collection === "audit_logs");
    expect(logs.at(-1)).toMatchObject({
      actor_id: "actor-super",
      action: "admin_role_assigned",
      target_type: "user",
      target_id: "alex",
      metadata: { previous_role: "support_admin", new_role: "auditor", result: "success" },
    });
  });

  it("uses the standard envelope for success and failure alike", async () => {
    const ok = await call("admin_role_catalog");
    expect(ok.body.success).toBe(true);
    expect(ok.body).toHaveProperty("data");

    const bad = await call("no_such_action");
    expect(bad.body.success).toBe(false);
    expect(bad.body.error).toMatchObject({ code: "UNKNOWN_ACTION" });
  });

  it("the role catalog is only readable by admins", async () => {
    sessionUid = "regular-user";
    const r = await call("admin_role_catalog");
    expect(r.status).toBe(403);
  });
});
