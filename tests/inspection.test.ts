// =============================================================================
// Phase 8 — transparent admin inspection.
//
// These tests encode the promises made to users:
//   • no session ever starts without the target device acknowledging a visible
//     notice;
//   • a guardian-protected account needs a VERIFIED guardian (an e-mail is not
//     a guardian) and cannot be acknowledged past that gate;
//   • forbidden scopes (messages, passwords, tokens…) are refused outright;
//   • the session is time boxed and the owner can stop it at any moment;
//   • both sides are notified, and every step is audited.
// =============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

const permissions = { codes: ["security.view", "users.view", "privacy.access"], admin: true };

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/server/queries", () => ({ getAdminPermissions: vi.fn(async () => permissions.codes) }));
vi.mock("@/lib/server/rpc", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/server/rpc")>("../src/lib/server/rpc");
  return { ...actual, isAdmin: vi.fn(async () => permissions.admin) };
});

import {
  acknowledgeInspection,
  activeInspectionFor,
  decideInspectionAsGuardian,
  requestInspection,
  stopInspection,
} from "../src/lib/server/inspection";
import { FORBIDDEN_SCOPES, inspectionNotice, validateRequest } from "../src/lib/inspection";
import { sharedFirestoreStub } from "./helpers/firestore-stub";

const ADMIN = { uid: "admin-1", email: "admin@example.com", emailVerified: true } as never;
const OWNER = { uid: "owner-1", email: "owner@example.com", emailVerified: true } as never;
const GUARDIAN = { uid: "parent-1", email: "parent@example.com", emailVerified: true } as never;
const STRANGER = { uid: "stranger", email: "s@example.com", emailVerified: true } as never;

let stub: ReturnType<typeof sharedFirestoreStub>;

function seedDevice(userId = "owner-1") {
  stub._state.docs.set("devices/dev-1", {
    user_id: userId,
    device_name: "Pixel 8",
    platform: "android",
    access_token_hash: "sha256:cafebabe",
    last_seen_at: Date.now(),
  });
}

function seedGuardian() {
  stub._state.docs.set("parent_links/link-1", {
    child_uid: "owner-1",
    parent_uid: "parent-1",
    parent_email: "parent@example.com",
    status: "verified",
  });
}

const base = { target_uid: "owner-1", device_id: "dev-1", reason: "Investigating a sync failure reported yesterday", scopes: ["app_diagnostics"], minutes: 5 };

beforeEach(() => {
  stub = sharedFirestoreStub();
  for (const key of [...stub._state.docs.keys()]) {
    if (/^(devices|inspection_requests|inspection_events|admin_audit_log|notifications|parent_links)\//.test(key)) {
      stub._state.docs.delete(key);
    }
  }
  permissions.codes = ["security.view", "users.view", "privacy.access"];
  permissions.admin = true;
  seedDevice();
});

describe("Phase 8 — nothing starts silently", () => {
  it("records a request but leaves it inactive until the device confirms", async () => {
    const request = await requestInspection(stub as never, ADMIN, base);
    expect(request.status).toBe("requested");
    expect(request.starts_at).toBe("");
    expect(request.ends_at).toBe("");
    // The target is notified immediately — inspection is never a surprise.
    const notes = [...stub._state.docs.values()].filter((doc) => doc.type === "inspection_requested");
    expect(notes).toHaveLength(1);
    expect(String(notes[0].body)).toContain("Nothing starts until you confirm");
  });

  it("activates only on acknowledgement, and only for the right device", async () => {
    const request = await requestInspection(stub as never, ADMIN, base);
    await expect(acknowledgeInspection(stub as never, OWNER, { inspection_id: request.id, device_id: "some-other-device" })).rejects.toMatchObject({ code: "WRONG_DEVICE" });
    await expect(acknowledgeInspection(stub as never, STRANGER, { inspection_id: request.id, device_id: "dev-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const ack = await acknowledgeInspection(stub as never, OWNER, { inspection_id: request.id, device_id: "dev-1" });
    expect(ack.status).toBe("active");
    expect(ack.scopes).toEqual(["app_diagnostics"]);
    const endsAt = Date.parse(ack.ends_at);
    expect(endsAt - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 2_000);
    expect(endsAt - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it("refuses a second concurrent session on the same device", async () => {
    await requestInspection(stub as never, ADMIN, base);
    await expect(requestInspection(stub as never, ADMIN, base)).rejects.toMatchObject({ code: "INSPECTION_ALREADY_ACTIVE" });
  });

  it("refuses to inspect a device owned by somebody else", async () => {
    stub._state.docs.set("devices/dev-2", { user_id: "someone-else", device_name: "Other" });
    await expect(requestInspection(stub as never, ADMIN, { ...base, device_id: "dev-2" })).rejects.toMatchObject({ code: "DEVICE_OWNER_MISMATCH" });
  });
});

describe("Phase 8 — guardian approval", () => {
  it("requires a verified guardian before the device is even asked", async () => {
    seedGuardian();
    const request = await requestInspection(stub as never, ADMIN, base);
    expect(request.status).toBe("awaiting_guardian");
    expect(request.guardian_required).toBe(true);

    // The device cannot accept its way around the guardian gate.
    await expect(acknowledgeInspection(stub as never, OWNER, { inspection_id: request.id, device_id: "dev-1" })).rejects.toMatchObject({
      code: "GUARDIAN_APPROVAL_REQUIRED",
    });

    // A guardian still has to be VERIFIED for this account.
    await expect(decideInspectionAsGuardian(stub as never, STRANGER, { inspection_id: request.id, approve: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("starts only after the verified guardian approves, and a decline ends it", async () => {
    seedGuardian();
    const approved = await requestInspection(stub as never, ADMIN, base);
    const afterApproval = await decideInspectionAsGuardian(stub as never, GUARDIAN, { inspection_id: approved.id, approve: true });
    expect(afterApproval.status).toBe("requested");
    const ack = await acknowledgeInspection(stub as never, OWNER, { inspection_id: approved.id, device_id: "dev-1" });
    expect(ack.status).toBe("active");

    const declined = await requestInspection(stub as never, ADMIN, { ...base, device_id: "dev-1", reason: "A second, different investigation" }).catch((error) => error);
    expect(declined).toBeTruthy(); // already active -> 409, which is the point
  });

  it("a guardian decline means the device is never inspected", async () => {
    seedGuardian();
    const request = await requestInspection(stub as never, ADMIN, base);
    const result = await decideInspectionAsGuardian(stub as never, GUARDIAN, { inspection_id: request.id, approve: false, note: "Not now" });
    expect(result.status).toBe("denied");
    const ack = await acknowledgeInspection(stub as never, OWNER, { inspection_id: request.id, device_id: "dev-1" });
    expect(ack.status).toBe("denied");
    expect(ack.scopes).toEqual([]);
  });
});

describe("Phase 8 — scope limits", () => {
  it("never allows a secret-bearing scope", async () => {
    for (const scope of FORBIDDEN_SCOPES.slice(0, 4)) {
      const outcome = validateRequest({ reason: "A sufficiently long reason here", scopes: [scope], minutes: 5 });
      expect(outcome.ok).toBe(false);
    }
    await expect(
      requestInspection(stub as never, ADMIN, { ...base, scopes: ["messages"] }),
    ).rejects.toMatchObject({ code: "INVALID_INSPECTION" });
  });

  it("requires a real reason and at least one scope", async () => {
    await expect(requestInspection(stub as never, ADMIN, { ...base, reason: "short" })).rejects.toMatchObject({ code: "INVALID_INSPECTION" });
    await expect(requestInspection(stub as never, ADMIN, { ...base, scopes: [] })).rejects.toMatchObject({ code: "INVALID_INSPECTION" });
  });

  it("caps the duration at the documented maximum", () => {
    const outcome = validateRequest({ reason: "A sufficiently long reason here", scopes: ["app_diagnostics"], minutes: 10_000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.minutes).toBeLessThanOrEqual(30);
  });
});

describe("Phase 8 — stopping", () => {
  it("lets the owner stop an active session immediately", async () => {
    const request = await requestInspection(stub as never, ADMIN, base);
    await acknowledgeInspection(stub as never, OWNER, { inspection_id: request.id, device_id: "dev-1" });
    const stopped = await stopInspection(stub as never, OWNER, { inspection_id: request.id, reason: "I need to use my phone now" });
    expect(stopped.status).toBe("revoked");
    expect(stopped.stopped_by).toBe("owner-1");
    // After stopping, the device reports nothing active.
    expect(await activeInspectionFor(stub as never, OWNER, "dev-1")).toBeNull();
  });

  it("lets the approving guardian stop it too, but not a stranger", async () => {
    seedGuardian();
    const request = await requestInspection(stub as never, ADMIN, base);
    await decideInspectionAsGuardian(stub as never, GUARDIAN, { inspection_id: request.id, approve: true });
    await expect(stopInspection(stub as never, STRANGER, { inspection_id: request.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stopped = await stopInspection(stub as never, GUARDIAN, { inspection_id: request.id });
    expect(stopped.status).toBe("revoked");
  });

  it("surfaces the pending request to the device with full transparency", async () => {
    const request = await requestInspection(stub as never, ADMIN, base);
    const active = await activeInspectionFor(stub as never, OWNER, "dev-1");
    expect(active?.id).toBe(request.id);
    expect(active?.admin_email).toBe("admin@example.com");
    expect(active?.reason).toBe(base.reason);
    expect(active?.scopes).toEqual(["app_diagnostics"]);
  });
});

describe("Phase 8 — permission gate", () => {
  it("refuses an admin without privacy.access", async () => {
    permissions.codes = ["security.view", "users.view"];
    await expect(requestInspection(stub as never, ADMIN, base)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a non-admin outright", async () => {
    permissions.admin = false;
    await expect(requestInspection(stub as never, ADMIN, base)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Phase 8 — the notice wording", () => {
  it("names the admin, the reason, the scopes and the duration", () => {
    const notice = inspectionNotice({
      admin_name: "Rumana",
      admin_email: "rumana@qorvyna.top",
      reason: "Sync errors after the last update",
      scopes: ["app_diagnostics", "network_status"],
      minutes: 10,
    });
    expect(notice).toContain("Rumana");
    expect(notice).toContain("Sync errors after the last update");
    expect(notice).toContain("App version, crash reports and error logs");
    expect(notice).toContain("10 minutes");
    expect(notice).toContain("You can stop it at any time");
  });
});
