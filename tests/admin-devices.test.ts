// =============================================================================
// Phase 7 — admin device dashboard.
//   • RBAC: `security.view` to read, `users.view` to moderate;
//   • secrets never leave the server (booleans only, no hashes or tokens);
//   • search/filter/online/status work on the sanitised projection;
//   • every moderation action is audited and revocation tears down links.
// =============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vi as vitestVi } from "vitest";

const permissions = { codes: ["security.view", "users.view"], admin: true };

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/server/queries", () => ({
  getAdminPermissions: vitestVi.fn(async () => permissions.codes),
}));
vi.mock("@/lib/server/rpc", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/server/rpc")>("../src/lib/server/rpc");
  return { ...actual, isAdmin: vitestVi.fn(async () => permissions.admin) };
});

import {
  adminDeviceDetail,
  adminPairingHistory,
  listAdminDevices,
  moderateDevice,
} from "../src/lib/server/admin-devices";
import { sharedFirestoreStub } from "./helpers/firestore-stub";

const ADMIN = { uid: "admin-1", email: "admin@example.com", emailVerified: true };
let stub: ReturnType<typeof sharedFirestoreStub>;

function seedDevice(id: string, overrides: Record<string, unknown> = {}) {
  stub._state.docs.set(`devices/${id}`, {
    user_id: "owner-1",
    device_name: "Pixel 8",
    platform: "android",
    os: "Android 15",
    app_version: "1.2.0",
    role: "parent",
    access_token_hash: "sha256:deadbeefcafebabe",
    paired_at: Date.now() - 86_400_000,
    last_seen_at: Date.now() - 30_000,
    last_ip: "203.0.113.7",
    location: "Rajshahi, BD",
    ...overrides,
  });
}

beforeEach(() => {
  stub = sharedFirestoreStub();
  for (const key of [...stub._state.docs.keys()]) {
    if (key.startsWith("devices/") || key.startsWith("device_events/") || key.startsWith("admin_audit_log/") || key.startsWith("device_links/")) {
      stub._state.docs.delete(key);
    }
  }
  permissions.codes = ["security.view", "users.view"];
  permissions.admin = true;
});

describe("Phase 7 — access control", () => {
  it("lets a security viewer read but not moderate", async () => {
    seedDevice("dev-a");
    permissions.codes = ["security.view"];
    await expect(listAdminDevices(stub as never, ADMIN as never)).resolves.toBeTruthy();
    await expect(moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "revoke", reason: "stolen" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks non-admins and users without security.view", async () => {
    seedDevice("dev-a");
    permissions.admin = false;
    await expect(listAdminDevices(stub as never, ADMIN as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    permissions.admin = true;
    permissions.codes = ["users.view"];
    await expect(listAdminDevices(stub as never, ADMIN as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Phase 7 — listing never leaks secrets", () => {
  it("returns a credential boolean, never the hash", async () => {
    seedDevice("dev-a");
    const result = await listAdminDevices(stub as never, ADMIN as never);
    const row = result.devices[0];
    expect(row.has_credential).toBe(true);
    expect(JSON.stringify(result)).not.toContain("deadbeef");
    expect(JSON.stringify(result)).not.toMatch(/token_hash|access_token|claim_hash|secret/i);
  });

  it("reports online/offline/last-seen from the real connection rule", async () => {
    seedDevice("dev-online", { last_seen_at: Date.now() - 10_000 });
    seedDevice("dev-offline", { last_seen_at: Date.now() - 6 * 60 * 60 * 1000 });
    seedDevice("dev-pending", { access_token_hash: null, role: "child", last_seen_at: null });
    const { devices } = await listAdminDevices(stub as never, ADMIN as never);
    const byId = Object.fromEntries(devices.map((row) => [row.id, row]));
    expect(byId["dev-online"].status).toBe("online");
    expect(byId["dev-offline"].status).toBe("offline");
    expect(byId["dev-pending"].status).toBe("pending");
  });

  it("filters by search, status, platform and online-only", async () => {
    seedDevice("dev-android", { device_name: "Pixel 8", platform: "android" });
    seedDevice("dev-windows", { device_name: "Studio PC", platform: "windows", last_seen_at: Date.now() - 9 * 60 * 60 * 1000, access_token_hash: "x" });
    const search = await listAdminDevices(stub as never, ADMIN as never, { search: "studio" });
    expect(search.devices.map((row) => row.id)).toEqual(["dev-windows"]);
    const platforms = await listAdminDevices(stub as never, ADMIN as never, { platform: "android" });
    expect(platforms.devices.map((row) => row.id)).toEqual(["dev-android"]);
    const online = await listAdminDevices(stub as never, ADMIN as never, { online_only: true });
    expect(online.devices.map((row) => row.id)).toEqual(["dev-android"]);
    const offline = await listAdminDevices(stub as never, ADMIN as never, { status: "offline" });
    expect(offline.devices.map((row) => row.id)).toEqual(["dev-windows"]);
  });

  it("scrubs secrets from device event detail", async () => {
    seedDevice("dev-a");
    stub._state.docs.set("device_events/evt-1", {
      device_id: "dev-a",
      type: "pairing",
      created_at: Date.now(),
      detail: { access_token_hash: "sha256:deadbeef", ok: true },
    });
    const detail = await adminDeviceDetail(stub as never, ADMIN as never, "dev-a");
    expect(JSON.stringify(detail)).not.toContain("deadbeef");
    expect(detail.events[0].detail).toMatchObject({ ok: true });
  });
});

describe("Phase 7 — moderation", () => {
  it("requires a written reason", async () => {
    seedDevice("dev-a");
    await expect(moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "block", reason: "" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("disables, blocks and re-enables with an audit trail", async () => {
    seedDevice("dev-a");
    await moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "disable", reason: "policy violation" });
    let row = (await listAdminDevices(stub as never, ADMIN as never)).devices[0];
    expect(row.suspended).toBe(true);
    expect(row.status).toBe("disconnected");

    await moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "block", reason: "abuse" });
    row = (await listAdminDevices(stub as never, ADMIN as never)).devices[0];
    expect(row.blocked).toBe(true);

    await moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "enable", reason: "appeal accepted" });
    await moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "unblock", reason: "appeal accepted" });
    row = (await listAdminDevices(stub as never, ADMIN as never)).devices[0];
    expect(row.suspended).toBe(false);
    expect(row.blocked).toBe(false);

    const audit = [...stub._state.docs.values()].filter((doc) => doc.action && String(doc.action).startsWith("device."));
    expect(audit.length).toBe(4);
    expect(audit.every((entry) => entry.actor_id === ADMIN.uid && entry.target_id === "dev-a")).toBe(true);
    expect(audit[0].reason).toBe("policy violation");
    // The audit log itself must not carry the credential hash.
    expect(JSON.stringify(audit)).not.toContain("deadbeef");
  });

  it("revoking a device also ends its cross-account links", async () => {
    seedDevice("dev-a", { user_id: "owner-1" });
    stub._state.docs.set("device_links/link-1", {
      a: { uid: "owner-1", device_id: "dev-a", approved: true },
      b: { uid: "other-owner", device_id: null, approved: true },
      status: "active",
      created_at: Date.now(),
    });
    await moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "revoke", reason: "stolen" });
    const link = stub._state.docs.get("device_links/link-1")!;
    expect(link.status).toBe("revoked");
    expect(link.revoked_by).toBe(ADMIN.uid);
  });

  it("refuses an unknown action and a missing device", async () => {
    seedDevice("dev-a");
    await expect(moderateDevice(stub as never, ADMIN as never, { device_id: "dev-a", action: "explode", reason: "because" })).rejects.toMatchObject({ code: "UNKNOWN_ACTION" });
    await expect(moderateDevice(stub as never, ADMIN as never, { device_id: "nope", action: "revoke", reason: "stolen" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Phase 7 — pairing history", () => {
  it("lists who linked to whom without any secret", async () => {
    stub._state.docs.set("device_links/link-1", {
      a: { uid: "alice", device_id: "a-1" },
      b: { uid: "bob", device_id: "b-1" },
      status: "active",
      created_at: Date.now(),
      code_hash: "sha256:supersecret",
    });
    const history = await adminPairingHistory(stub as never, ADMIN as never);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ a: "alice", b: "bob", status: "active" });
    expect(JSON.stringify(history)).not.toContain("supersecret");
  });
});
