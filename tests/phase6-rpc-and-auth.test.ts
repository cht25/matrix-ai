// Route-level & Auth/RBAC/CSRF/Scope integration test for all new `/api/rpc` actions.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeFirestore } from "./helpers/test-db";
import { DEVICE_TOKEN_PREFIX, deviceCredentialHash, verifyDeviceCredential } from "@/lib/firebase/device-session";

const fakeDb = makeFakeFirestore();
let currentUser: {
  uid: string;
  email: string | null;
  emailVerified?: boolean;
  deviceId?: string;
  scopes?: string[];
} | null = null;

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => fakeDb,
  nowTs: () => new Date(),
  toTs: (v: unknown) => v,
  adminConfigured: () => true,
}));

vi.mock("@/lib/firebase/session", () => ({
  getSessionUser: async () => currentUser,
}));

const { POST } = await import("../src/app/api/rpc/route");

async function callRpc(
  action: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = { Origin: "http://localhost" },
) {
  const req = new Request("http://localhost/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action, ...args }),
  });
  const res = await POST(req as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_super_secret_key_never_expose";
  process.env.PAIRING_TOKEN_SECRET = "0123456789abcdef0123456789abcdef";
  currentUser = {
    uid: "user-1",
    email: "user@example.com",
    emailVerified: true,
  };
});

describe("Phase 6 — /api/rpc Authorization, CSRF, Scopes & Secret Isolation", () => {
  it("blocks unauthenticated and cross-origin calls before reaching any handler", async () => {
    const crossOrigin = await callRpc("reminders_list", {}, { Origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);

    currentUser = null;
    const unauth = await callRpc("reminders_list");
    expect(unauth.status).toBe(401);
  });

  it("enforces system.settings RBAC on admin_email_status and NEVER exposes RESEND_API_KEY", async () => {
    // Non-admin rejected with 403
    const nonAdmin = await callRpc("admin_email_status");
    expect(nonAdmin.status).toBe(403);

    // Super admin succeeds without exposing key
    await fakeDb.collection("admin_role_assignments").doc("user-1").set({ role_id: "super_admin" });
    const adminRes = await callRpc("admin_email_status");
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.success).toBe(true);
    const serialized = JSON.stringify(adminRes.body);
    expect(serialized).toContain('"api_key_configured":true');
    expect(serialized).not.toContain("re_super_secret_key_never_expose");
  });

  it("enforces device scope isolation for Child bearer sessions vs explicit granted scopes", async () => {
    // Create active child device missing notifications:write
    const secret = crypto.randomBytes(32).toString("base64url"); // 43 chars
    const deviceId = "dev_restricted_1";
    const token = `${DEVICE_TOKEN_PREFIX}${deviceId}.${secret}`;
    await fakeDb.collection("devices").doc(deviceId).set({
      user_id: "user-1",
      role: "child",
      device_name: "Child Watch",
      platform: "wearos",
      scopes: ["devices:read"],
      access_token_hash: deviceCredentialHash(deviceId, secret),
      access_token_expires_at: new Date(Date.now() + 3600_000),
      revoked_at: null,
      suspended_at: null,
    });

    // Simulate verified Child device session (missing notifications:write)
    const verifiedRestricted = await verifyDeviceCredential(fakeDb as never, token);
    expect(verifiedRestricted?.deviceId).toBe(deviceId);
    currentUser = verifiedRestricted;
    const deniedRes = await callRpc("notifications_sync_ingest", {
      package_name: "com.test",
      app_name: "Test",
      title: "Hello",
    });
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.error).toMatchObject({ code: "DEVICE_SCOPE_DENIED" });

    // Grant notifications:write scope & enable sync -> allowed
    await fakeDb.collection("devices").doc(deviceId).set({ scopes: ["devices:read", "notifications:write"] }, { merge: true });
    await fakeDb.collection("notification_preferences").doc("user-1").set({
      user_id: "user-1",
      sync_enabled: true,
      privacy_mode: "full",
      redact_otp: true,
      excluded_apps: [],
      allowed_target_device_ids: [],
    });
    currentUser = await verifyDeviceCredential(fakeDb as never, token);
    const allowedRes = await callRpc("notifications_sync_ingest", {
      package_name: "com.test",
      app_name: "Test",
      title: "Hello",
    });
    expect(allowedRes.status).toBe(200);
    expect(allowedRes.body.success).toBe(true);
    expect((allowedRes.body.data as { synced: boolean }).synced).toBe(true);
  });

  it("supports Jarvis reminders and enforces approval boundary on tool_execute", async () => {
    const created = await callRpc("reminders_create", { title: "Check Resend DNS" });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);

    const listed = await callRpc("reminders_list");
    expect(listed.status).toBe(200);
    expect((listed.body.data as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Medium-risk tool device.open_app via tool_execute without approval is blocked (ok: false, APPROVAL_REQUIRED)
    const unapproved = await callRpc("tool_execute", {
      tool_id: "device.open_app",
      args: { target_device_id: "dev_restricted_1", app_name: "notepad" },
    });
    expect(unapproved.status).toBe(200);
    expect(unapproved.body.data).toMatchObject({ ok: false, error: "APPROVAL_REQUIRED" });
    expect(Object.keys(fakeDb.dump("device_commands")).length).toBe(0);
  });
});
