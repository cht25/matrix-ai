import { describe, expect, it } from "vitest";
import { ALL_ADMIN_PERMISSION_CODES, normalizeAdminPermission } from "../src/lib/admin-rbac";
import { listAdminPermissionCodes } from "../src/lib/server/rpc";

function assignmentDoc(roleId: string | null) {
  return {
    exists: Boolean(roleId),
    data: () => (roleId ? { role_id: roleId } : undefined),
  };
}

function fakeDb(opts: {
  roleId?: string | null;
  links?: { id: string; role_id: string; permission_id?: string }[];
}) {
  return {
    collection: (name: string) => ({
      doc: (_id: string) => ({
        get: async () => (name === "admin_role_assignments" ? assignmentDoc(opts.roleId ?? null) : { exists: false, data: () => undefined }),
      }),
      where: (_field: string, _op: string, value: string) => ({
        get: async () => {
          const docs = (opts.links ?? [])
            .filter((l) => l.role_id === value)
            .map((l) => ({ id: l.id, data: () => l }));
          return { docs, empty: docs.length === 0 };
        },
      }),
    }),
  };
}

describe("normalizeAdminPermission", () => {
  it("maps the legacy reports.manage code onto reports.view", () => {
    expect(normalizeAdminPermission("reports.manage")).toBe("reports.view");
    expect(normalizeAdminPermission("users.view")).toBe("users.view");
  });
});

describe("listAdminPermissionCodes", () => {
  it("returns nothing for a non-admin", async () => {
    const codes = await listAdminPermissionCodes(fakeDb({ roleId: null }) as never, "u1");
    expect(codes).toEqual([]);
  });

  it("gives super_admin the full matrix even with no seed links", async () => {
    const codes = await listAdminPermissionCodes(fakeDb({ roleId: "super_admin", links: [] }) as never, "u1");
    expect(codes).toEqual([...ALL_ADMIN_PERMISSION_CODES]);
    expect(codes).toContain("users.view");
    expect(codes).toContain("content.manage");
    expect(codes).toContain("system.settings");
  });

  it("reads permission_id from role links for other roles", async () => {
    const codes = await listAdminPermissionCodes(
      fakeDb({
        roleId: "auditor",
        links: [
          { id: "auditor__audit.view", role_id: "auditor", permission_id: "audit.view" },
          { id: "auditor__ai.view", role_id: "auditor", permission_id: "ai.view" },
        ],
      }) as never,
      "u1",
    );
    expect(codes.sort()).toEqual(["ai.view", "audit.view"]);
  });

  it("falls back to the document id when permission_id is missing", async () => {
    const codes = await listAdminPermissionCodes(
      fakeDb({
        roleId: "support_admin",
        links: [{ id: "support_admin__users.view", role_id: "support_admin" }],
      }) as never,
      "u1",
    );
    expect(codes).toEqual(["users.view"]);
  });
});
