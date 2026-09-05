import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_ROLES, ADMIN_ROLE_IDS, NO_ROLE, isAdminRoleId, isAssignableRoleValue,
  normalizeRoleInput, permissionsForRole, roleLabel, ROLE_PERMISSION_MATRIX,
} from "../src/lib/roles";
import { ALL_ADMIN_PERMISSION_CODES } from "../src/lib/admin-rbac";
import { mapAdminError, errorCodeOf } from "../src/lib/admin-errors";
import { adminSetUserRole, seedAdminRbac } from "../src/lib/server/rpc";

// ---------------------------------------------------------------------------
// Canonical catalog
// ---------------------------------------------------------------------------
describe("canonical role catalog", () => {
  it("matches the roles seeded by seed/0007_seed.sql", () => {
    expect([...ADMIN_ROLE_IDS].sort()).toEqual(
      ["auditor", "content_admin", "security_admin", "super_admin", "support_admin"],
    );
  });

  it("only references permission codes that actually exist", () => {
    for (const role of ADMIN_ROLES) {
      for (const code of role.permissions) {
        expect(ALL_ADMIN_PERMISSION_CODES).toContain(code);
      }
    }
  });

  it("gives super_admin the whole permission matrix", () => {
    expect([...ROLE_PERMISSION_MATRIX.super_admin]).toEqual([...ALL_ADMIN_PERMISSION_CODES]);
  });

  it("exposes human labels, never raw ids", () => {
    expect(roleLabel("super_admin")).toBe("Super administrator");
    expect(roleLabel(null)).toBe("Standard user");
    expect(permissionsForRole("auditor")).toContain("audit.view");
    expect(permissionsForRole("nonsense")).toEqual([]);
  });
});

describe("role validation", () => {
  it("accepts every canonical id and the none sentinel", () => {
    for (const id of ADMIN_ROLE_IDS) expect(isAssignableRoleValue(id)).toBe(true);
    expect(isAssignableRoleValue(NO_ROLE)).toBe(true);
  });

  it("rejects unknown values and non-strings", () => {
    expect(isAdminRoleId("wizard")).toBe(false);
    expect(isAssignableRoleValue({ role: "super_admin" })).toBe(false);
    expect(normalizeRoleInput({ id: "super_admin" })).toBeNull();
    expect(normalizeRoleInput("wizard")).toBeNull();
  });

  it("normalises casing, spacing and legacy aliases", () => {
    expect(normalizeRoleInput("ADMIN")).toBe("super_admin");
    expect(normalizeRoleInput("Super Admin")).toBe("super_admin");
    expect(normalizeRoleInput("super-admin")).toBe("super_admin");
    expect(normalizeRoleInput("moderator")).toBe("support_admin");
    expect(normalizeRoleInput("USER")).toBe(NO_ROLE);
    expect(normalizeRoleInput("none")).toBe(NO_ROLE);
  });
});

// ---------------------------------------------------------------------------
// Error mapping — internal codes must never be the headline message
// ---------------------------------------------------------------------------
describe("admin error mapper", () => {
  it("turns ROLE_INVALID into a human sentence and keeps the code for logs", () => {
    const view = mapAdminError("ROLE_INVALID");
    expect(view.title).toBe("Unable to update role");
    expect(view.title).not.toContain("ROLE_INVALID");
    expect(view.detail).not.toContain("ROLE_INVALID");
    expect(view.code).toBe("ROLE_INVALID");
  });

  it("never leaks a raw code as the title for any known internal code", () => {
    for (const code of ["PERMISSION_DENIED", "UNAUTHENTICATED", "BAD_REQUEST", "INTERNAL", "HTTP_500", "VALIDATION_ERROR"]) {
      const view = mapAdminError(code);
      expect(view.title).not.toMatch(/^[A-Z_0-9]+$/);
      expect(view.detail.length).toBeGreaterThan(10);
    }
  });

  it("extracts codes from thrown RpcCallError-shaped objects", () => {
    expect(errorCodeOf({ code: "ROLE_INVALID" })).toBe("ROLE_INVALID");
    expect(errorCodeOf(undefined, "LOAD_FAILED")).toBe("LOAD_FAILED");
  });
});

// ---------------------------------------------------------------------------
// adminSetUserRole — end-to-end against an in-memory Firestore double
// ---------------------------------------------------------------------------
type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Record<string, Doc>> = {}) {
  const store: Record<string, Record<string, Doc>> = JSON.parse(JSON.stringify(seed));
  const col = (name: string) => (store[name] ??= {});
  const added: Doc[] = [];
  return {
    store,
    added,
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const data = col(name)[id];
              return { exists: data !== undefined, id, data: () => data };
            },
            async set(value: Doc, opts?: { merge?: boolean }) {
              col(name)[id] = opts?.merge ? { ...(col(name)[id] ?? {}), ...value } : value;
            },
            async delete() { delete col(name)[id]; },
          };
        },
        async add(value: Doc) { added.push({ collection: name, ...value }); return { id: `gen-${added.length}` }; },
        async get() {
          const docs = Object.entries(col(name)).map(([id, data]) => ({ id, data: () => data }));
          return { docs, empty: docs.length === 0, size: docs.length };
        },
        limit() { return this; },
        where(_f: string, _op: string, value: string) {
          return {
            async get() {
              const docs = Object.entries(col(name))
                .filter(([, d]) => (d as { role_id?: string }).role_id === value)
                .map(([id, data]) => ({ id, data: () => data }));
              return { docs, empty: docs.length === 0, size: docs.length };
            },
          };
        },
      };
    },
  };
}

const claims: Record<string, unknown> = {};
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    async setCustomUserClaims(uid: string, value: unknown) { claims[uid] = value; },
    async updateUser() { return {}; },
    async revokeRefreshTokens() {},
  }),
}));
vi.mock("@/lib/firebase/admin", () => ({
  nowTs: () => "TS",
  toTs: (v: unknown) => v,
  adminDb: () => ({}),
}));

const ACTOR = { uid: "actor-super" } as never;

function dbWithSuperAdmin() {
  return makeDb({
    admin_role_assignments: { "actor-super": { role_id: "super_admin" } },
    admin_roles: {}, // deliberately EMPTY — reproduces the ROLE_INVALID bug
  });
}

describe("adminSetUserRole", () => {
  it("REGRESSION: assigns security_admin even when admin_roles was never seeded (the ROLE_INVALID bug)", async () => {
    const d = dbWithSuperAdmin();
    const result = await adminSetUserRole(d as never, ACTOR, { uid: "alex", role: "security_admin" });
    expect(result.role).toBe("security_admin");
    expect(d.store.admin_role_assignments.alex).toMatchObject({ role_id: "security_admin", assigned_by: "actor-super" });
  });

  it("USER → ADMIN then ADMIN → USER persists in the database", async () => {
    const d = dbWithSuperAdmin();
    await adminSetUserRole(d as never, ACTOR, { uid: "alex", role: "super_admin" });
    expect(d.store.admin_role_assignments.alex.role_id).toBe("super_admin");
    expect(claims.alex).toEqual({ admin: true, role: "super_admin" });

    const removed = await adminSetUserRole(d as never, ACTOR, { uid: "alex", role: "none" });
    expect(removed.role).toBeNull();
    expect(d.store.admin_role_assignments.alex).toBeUndefined();
    expect(claims.alex).toEqual({ admin: false });
  });

  it("accepts legacy/differently-cased values instead of failing with ROLE_INVALID", async () => {
    const d = dbWithSuperAdmin();
    const r = await adminSetUserRole(d as never, ACTOR, { uid: "alex", role: "ADMIN" });
    expect(r.role).toBe("super_admin");
  });

  it("rejects a genuinely invalid role with ROLE_INVALID", async () => {
    const d = dbWithSuperAdmin();
    await expect(adminSetUserRole(d as never, ACTOR, { uid: "alex", role: "wizard" }))
      .rejects.toMatchObject({ code: "ROLE_INVALID", status: 400 });
    expect(d.store.admin_role_assignments.alex).toBeUndefined();
  });

  it("rejects a non-super-admin caller (authorization is server-side)", async () => {
    const d = makeDb({ admin_role_assignments: { "actor-support": { role_id: "support_admin" } } });
    await expect(adminSetUserRole(d as never, { uid: "actor-support" } as never, { uid: "alex", role: "auditor" }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
  });

  it("rejects an unauthenticated/unassigned caller", async () => {
    const d = makeDb({});
    await expect(adminSetUserRole(d as never, { uid: "nobody" } as never, { uid: "alex", role: "auditor" }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("prevents a super admin from locking themselves out", async () => {
    const d = dbWithSuperAdmin();
    await expect(adminSetUserRole(d as never, ACTOR, { uid: "actor-super", role: "none" }))
      .rejects.toMatchObject({ code: "ROLE_SELF_DEMOTION" });
  });

  it("writes an audit record with actor, target, previous and new role", async () => {
    const d = dbWithSuperAdmin();
    await adminSetUserRole(d as never, ACTOR, { uid: "alex", role: "support_admin" });
    await adminSetUserRole(d as never, ACTOR, { uid: "alex", role: "auditor" });
    const audits = d.added.filter((a) => a.collection === "audit_logs");
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      actor_id: "actor-super",
      action: "admin_role_assigned",
      target_id: "alex",
      metadata: { previous_role: "support_admin", new_role: "auditor", result: "success" },
    });
  });
});

describe("seedAdminRbac", () => {
  it("seeds every canonical role and its permission links", async () => {
    const d = makeDb({});
    await seedAdminRbac(d as never);
    for (const role of ADMIN_ROLES) {
      expect(d.store.admin_roles[role.id]).toBeDefined();
      for (const code of role.permissions) {
        expect(d.store.admin_role_permissions[`${role.id}__${code}`]).toMatchObject({ role_id: role.id, permission_id: code });
      }
    }
    // The old seeder only created 3 roles — this is what broke role assignment.
    expect(Object.keys(d.store.admin_roles)).toHaveLength(5);
  });
});
