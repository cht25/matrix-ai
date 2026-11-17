import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeFirestore } from "./helpers/test-db";
import {
  decideProtectedAction,
  evaluateAndHandleProtectedEvent,
  getParentPolicy,
  listParentDashboard,
  requestParentLink,
  updateParentPolicy,
  verifyParentLink,
} from "@/lib/server/parent-policy";
import {
  clearSyncedNotificationHistory,
  dismissSyncedNotification,
  ingestSyncedNotification,
  listSyncedNotifications,
  updateNotificationPreferences,
} from "@/lib/server/notifications-sync";
import {
  claimPairing,
  createParentPairing,
  decidePairing,
  registerParentDevice,
  requestPairing,
  revokeHubDevice,
} from "@/lib/server/device-hub";
import type { SessionUser } from "@/lib/firebase/session";

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

const CHILD_USER: SessionUser = {
  uid: "child-uid",
  email: "child@example.com",
  emailVerified: true,
};

const PARENT_USER: SessionUser = {
  uid: "parent-uid",
  email: "parent@example.com",
  emailVerified: true,
};

const STRANGER_USER: SessionUser = {
  uid: "stranger-uid",
  email: "stranger@example.com",
  emailVerified: true,
};

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_secret_12345";
  process.env.PAIRING_TOKEN_SECRET = "0123456789abcdef0123456789abcdef";
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: "re_ok_1" }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
});

describe("Phase 2 — Verified Parent Links, Policy Enforcement & Cooldown", () => {
  it("blocks parent alerts before explicit parent email verification, then verifies only via exact verified email", async () => {
    const db = makeFakeFirestore();

    const req = await requestParentLink(db as never, CHILD_USER, {
      parent_email: "parent@example.com",
      relationship_label: "Mother",
    });
    expect(req.email_status).toBe("accepted_by_provider");

    // Extract raw token from the verification URL sent in email body (not stored plaintext in Firestore!)
    const sentPayload = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    const linkMatch = /verify_parent=([A-Za-z0-9_-]+)/.exec(sentPayload.text as string);
    expect(linkMatch).toBeTruthy();
    const rawToken = linkMatch![1];

    // Stored record has hash, not plaintext token
    const storedLink = db.dump("parent_links")[req.link_id];
    expect(storedLink.status).toBe("pending_verification");
    expect(storedLink.token_hash).toBe(crypto.createHash("sha256").update(rawToken).digest("hex"));
    expect(JSON.stringify(storedLink)).not.toContain(rawToken);

    // Before verification: protected event sends NO parent alert
    const beforeVerify = await evaluateAndHandleProtectedEvent(db as never, CHILD_USER, {
      event_type: "notification_access_enabled",
      action_type: "notification_access",
      target_id: "phone-1",
      summary: "Notification Access enabled",
    });
    expect(beforeVerify.status).toBe("no_parent_policy");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Wrong account cannot verify token
    await expect(verifyParentLink(db as never, STRANGER_USER, { token: rawToken })).rejects.toThrow("PARENT_EMAIL_MISMATCH");

    // Unverified email parent cannot verify token
    await expect(
      verifyParentLink(db as never, { ...PARENT_USER, emailVerified: false }, { token: rawToken }),
    ).rejects.toThrow("PARENT_EMAIL_MISMATCH");

    // Intended verified parent verifies once; replay fails
    const verified = await verifyParentLink(db as never, PARENT_USER, { token: rawToken });
    expect(verified.status).toBe("verified");
    await expect(verifyParentLink(db as never, PARENT_USER, { token: rawToken })).rejects.toThrow("PARENT_LINK_INVALID");
  });

  it("enforces anti-spam cooldown window and requires parent in-app approval for device unpairing when enabled", async () => {
    const db = makeFakeFirestore();
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;

    const req = await requestParentLink(db as never, CHILD_USER, { parent_email: "parent@example.com" });
    const rawToken = /verify_parent=([A-Za-z0-9_-]+)/.exec(
      JSON.parse(String(fetchSpy.mock.calls[0][1].body)).text as string,
    )![1];
    await verifyParentLink(db as never, PARENT_USER, { token: rawToken });

    // Trigger notification_access_enabled alert -> 1 parent alert email sent
    const ev1 = await evaluateAndHandleProtectedEvent(db as never, CHILD_USER, {
      event_type: "notification_access_enabled",
      action_type: "notification_access",
      target_id: "dev-1",
      summary: "Notification access enabled",
    });
    expect(ev1.status).toBe("notified");
    expect(fetchSpy).toHaveBeenCalledTimes(2); // 1 verification + 1 alert

    // Immediate duplicate event inside cooldown window is suppressed
    const ev2 = await evaluateAndHandleProtectedEvent(db as never, CHILD_USER, {
      event_type: "notification_access_enabled",
      action_type: "notification_access",
      target_id: "dev-1",
      summary: "Notification access enabled again",
    });
    expect(ev2.status).toBe("cooldown_suppressed");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Parent enables require_parent_approval on device_unpaired & policy_disabled
    const curPolicy = await getParentPolicy(db as never, CHILD_USER.uid);
    await updateParentPolicy(db as never, PARENT_USER, {
      target_uid: CHILD_USER.uid,
      rules: {
        ...curPolicy.rules,
        device_unpaired: { ...curPolicy.rules.device_unpaired, enabled: true, require_parent_approval: true },
        policy_disabled: { ...curPolicy.rules.policy_disabled, enabled: true, require_parent_approval: true },
      },
    });

    // Pair a child device under CHILD_USER
    const parentDev = await registerParentDevice(db as never, CHILD_USER, {
      client_id: "client-child-account-123456",
      device_name: "Child Laptop",
      device_type: "desktop",
      platform: "web",
    });
    const pair = await createParentPairing(db as never, CHILD_USER, { parent_device_id: parentDev.id });
    const reqPair = await requestPairing(db as never, CHILD_USER, {
      manual_code: pair.manual_code,
      device_name: "Child Phone",
      device_type: "phone",
      platform: "android",
    });
    await decidePairing(db as never, CHILD_USER, { challenge_id: reqPair.challenge_id, approve: true });
    const claimed = await claimPairing(db as never, CHILD_USER, {
      challenge_id: reqPair.challenge_id,
      claim_secret: reqPair.claim_secret,
    });
    expect(claimed.status).toBe("approved");
    const childDeviceId = (claimed as { device: { id: string } }).device.id;

    // Attempting to revoke device as CHILD_USER holds in pending_approval instead of immediate revocation
    const holdRes = await revokeHubDevice(db as never, CHILD_USER, childDeviceId);
    expect(holdRes).toMatchObject({ status: "pending_approval" });
    expect(db.dump("devices")[childDeviceId].revoked_at).toBeFalsy();

    // Child cannot disable policy without approval either
    const policyHold = await updateParentPolicy(db as never, CHILD_USER, {
      rules: {
        ...curPolicy.rules,
        policy_disabled: { enabled: false, require_parent_approval: false, cooldown_minutes: 15 },
      },
    });
    expect(policyHold.status).toBe("pending_approval");

    // Parent inspects pending approvals & approves device revocation in-app
    const dash = await listParentDashboard(db as never, PARENT_USER);
    expect(dash.actions.filter((a) => a.status === "pending_approval").length).toBe(2);
    const revokeReqId = (holdRes as { request_id: string }).request_id;
    await decideProtectedAction(db as never, PARENT_USER, { request_id: revokeReqId, approve: true });

    // Now the device IS revoked
    expect(db.dump("devices")[childDeviceId].revoked_at).toBeTruthy();
  });
});

describe("Phase 2 — Cross-Device Notification Sync, Privacy & Isolation", () => {
  it("applies excluded apps pre-storage, OTP redaction, privacy masking, and cross-user isolation", async () => {
    const db = makeFakeFirestore();

    await updateNotificationPreferences(db as never, CHILD_USER, {
      sync_enabled: true,
      privacy_mode: "full",
      redact_otp: true,
      excluded_apps: ["com.bank.secret"],
    });

    // Excluded app dropped before storage
    const dropped = await ingestSyncedNotification(db as never, CHILD_USER, {
      package_name: "com.bank.secret",
      app_name: "Secret Bank",
      title: "Balance alert",
      body: "$500",
    });
    expect(dropped).toEqual({ synced: false, reason: "excluded_app" });
    expect(Object.keys(db.dump("synced_notifications")).length).toBe(0);

    // Register an active Android device owned by CHILD_USER so remote dismiss queues truthfully
    const androidDev = await registerParentDevice(db as never, CHILD_USER, {
      client_id: "android-client-id-123456",
      device_name: "Pixel Phone",
      device_type: "phone",
      platform: "android",
    });

    // OTP redacted before storage
    const storedOtp = await ingestSyncedNotification(db as never, CHILD_USER, {
      package_name: "com.sms.messages",
      app_name: "Messages",
      title: "Verification code",
      body: "Your OTP code is 492817. Do not share.",
      source_platform: "android",
      source_device_id: androidDev.id,
      external_key: "0|com.sms.messages|12|null|100",
    });
    expect(storedOtp.synced).toBe(true);
    const list = await listSyncedNotifications(db as never, CHILD_USER);
    expect(list.items[0].body).toContain("[CODE]");
    expect(list.items[0].body).not.toContain("492817");

    // Title-only mode strips body
    await updateNotificationPreferences(db as never, CHILD_USER, { privacy_mode: "title_only" });
    await ingestSyncedNotification(db as never, CHILD_USER, {
      package_name: "com.chat.app",
      app_name: "Chat",
      title: "New message from Alex",
      body: "Secret private text",
    });
    const list2 = await listSyncedNotifications(db as never, CHILD_USER);
    const chatRow = list2.items.find((n) => n.app_name === "Chat")!;
    expect(chatRow.title).toBe("New message from Alex");
    expect(chatRow.body).toBe("");

    // Stranger cannot read or dismiss CHILD_USER notifications
    const strangerList = await listSyncedNotifications(db as never, STRANGER_USER);
    expect(strangerList.items).toEqual([]);
    await expect(dismissSyncedNotification(db as never, STRANGER_USER, { id: chatRow.id })).rejects.toThrow("NOT_FOUND");

    // Owner dismisses Android notification -> queues dismiss_notification command
    const dismissRes = await dismissSyncedNotification(db as never, CHILD_USER, {
      id: storedOtp.id!,
    });
    expect(dismissRes.command_queued).toBe(true);
    const cmds = Object.values(db.dump("device_commands"));
    expect(cmds[0].command).toBe("dismiss_notification");

    // Clear history
    const cleared = await clearSyncedNotificationHistory(db as never, CHILD_USER);
    expect(cleared.cleared).toBeGreaterThanOrEqual(1);
  });
});
