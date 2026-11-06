// MATRIX Family: role separation invariants (pure logic, shared client/server).
import { describe, expect, it } from "vitest";
import {
  assertRoleAssignmentAllowed,
  canManageFamilyMember,
  isAccountRole,
  isChildDeviceFeature,
  isFamilyRole,
  membershipDocId,
} from "@/lib/family";

describe("family role model", () => {
  it("parents manage children only", () => {
    expect(canManageFamilyMember("parent", "child")).toBe(true);
    expect(canManageFamilyMember("parent", "parent")).toBe(false);
    expect(canManageFamilyMember("child", "child")).toBe(false);
    expect(canManageFamilyMember("child", "parent")).toBe(false);
  });
  it("a family child can never hold an org-level role", () => {
    expect(() => assertRoleAssignmentAllowed("individual", "child")).not.toThrow();
    expect(() => assertRoleAssignmentAllowed("org_admin", "child")).toThrow(/ROLE_CONFLICT/);
    expect(() => assertRoleAssignmentAllowed("support_operator", "child")).toThrow(/ROLE_CONFLICT/);
    expect(() => assertRoleAssignmentAllowed("org_admin", null)).not.toThrow();
  });
  it("validates role and feature enums", () => {
    expect(isAccountRole("org_admin")).toBe(true);
    expect(isAccountRole("superuser")).toBe(false);
    expect(isFamilyRole("parent")).toBe(true);
    expect(isFamilyRole("owner")).toBe(false);
    expect(isChildDeviceFeature("screen_time")).toBe(true);
    expect(isChildDeviceFeature("read_sms")).toBe(false); // not a permitted feature
  });
  it("membership doc ids are deterministic per (user, family)", () => {
    expect(membershipDocId("u1", "f1")).toBe("u1_f1");
    expect(membershipDocId("u1", "f1")).toBe(membershipDocId("u1", "f1"));
  });
});
