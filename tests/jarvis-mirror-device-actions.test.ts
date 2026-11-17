import { describe, expect, it } from "vitest";
import { makeFakeFirestore } from "./helpers/test-db";
import { detectJarvisDeviceIntent, matchWakeWord } from "@/lib/voice/jarvis-engine";
import { DEFAULT_CHILD_PERMISSIONS, DEVICE_PERMISSIONS } from "@/lib/devices/model";
import { rpcDeviceScope } from "@/lib/firebase/device-session";
import {
  createMirrorSession,
  postMirrorSignal,
  respondMirrorConsent,
  stopMirrorSession,
} from "@/lib/server/mirror-webrtc";
import {
  completeReminder,
  createReminder,
  listReminders,
  pollDeviceCommands,
  queueDeviceCommand,
  reportDeviceCommandResult,
} from "@/lib/server/device-actions";
import { registerParentDevice } from "@/lib/server/device-hub";
import "@/lib/ai/tools";
import { toolRegistry } from "@/lib/ai/tools/registry";
import type { SessionUser } from "@/lib/firebase/session";

const OWNER: SessionUser = {
  uid: "owner-1",
  email: "owner@example.com",
  emailVerified: true,
};

const OTHER: SessionUser = {
  uid: "other-2",
  email: "other@example.com",
  emailVerified: true,
};

describe("Phase 1 — Jarvis Wake-Word & Intent Classification", () => {
  it("matches English and Bangla Hey QORVYNA wake variants and extracts immediate command", () => {
    expect(matchWakeWord("Hey QORVYNA")).toEqual({
      matched: true,
      wakeVariant: "hey qorvyna",
      commandText: "",
    });
    expect(matchWakeWord("Hey korvina, remind me to call Doctor")).toEqual({
      matched: true,
      wakeVariant: "hey qorvyna",
      commandText: "remind me to call Doctor",
    });
    expect(matchWakeWord("হে করভিনা ডিভাইস স্ট্যাটাস")).toEqual({
      matched: true,
      wakeVariant: "হে করভিনা",
      commandText: "ডিভাইস স্ট্যাটাস",
    });
    expect(matchWakeWord("Please explain photosynthesis")).toEqual({
      matched: false,
      wakeVariant: "",
      commandText: "",
    });
  });

  it("classifies device/reminder commands with strict confirmation boundaries", () => {
    const rem = detectJarvisDeviceIntent("Remind me to submit homework");
    expect(rem).toMatchObject({ toolId: "reminders.create", requiresConfirmation: false });

    const status = detectJarvisDeviceIntent("Check device status");
    expect(status).toMatchObject({ toolId: "device.status", requiresConfirmation: false });

    const openApp = detectJarvisDeviceIntent("Open notepad");
    expect(openApp).toMatchObject({ toolId: "device.open_app", requiresConfirmation: true, args: { app_name: "notepad" } });

    const media = detectJarvisDeviceIntent("Pause music");
    expect(media).toMatchObject({ toolId: "device.media_control", requiresConfirmation: true, args: { action: "play_pause" } });

    // Ordinary AI queries must pass through to chat normally
    expect(detectJarvisDeviceIntent("Open a project plan for physics study")).toBeNull();
    expect(detectJarvisDeviceIntent("What is the capital of Bangladesh?")).toBeNull();
  });
});

describe("Phase 3 — Device Permissions, WebRTC Mirror Consent & Tool Registry", () => {
  it("keeps sensitive scopes opt-in (excluded from default child permissions) and maps RPC scopes", () => {
    for (const sensitive of ["notifications:write", "devices:control", "mirror:share", "remote:control"] as const) {
      expect(DEVICE_PERMISSIONS).toContain(sensitive);
      expect(DEFAULT_CHILD_PERMISSIONS).not.toContain(sensitive);
    }
    expect(rpcDeviceScope("notifications_sync_ingest")).toBe("notifications:write");
    expect(rpcDeviceScope("device_command_queue")).toBe("devices:control");
    expect(rpcDeviceScope("mirror_session_create")).toBe("mirror:view");
    expect(rpcDeviceScope("mirror_session_respond")).toBe("mirror:share");
  });

  it("enforces explicit source consent, view-only default, and immediate stop on WebRTC mirror sessions", async () => {
    const db = makeFakeFirestore();
    const phone = await registerParentDevice(db as never, OWNER, {
      client_id: "phone-client-id-12345678",
      device_name: "Pixel Phone",
      device_type: "phone",
      platform: "android",
    });

    const created = await createMirrorSession(db as never, OWNER, {
      source_device_id: phone.id,
      remote_control_requested: false,
      ttl_minutes: 60, // capped to 15 min
    });
    expect(created.status).toBe("awaiting_source_consent");
    expect(created.mode).toBe("view_only");
    expect(created.remote_control_enabled).toBe(false);

    // Signaling blocked before explicit source consent
    await expect(
      postMirrorSignal(db as never, OWNER, {
        session_id: created.session_id,
        from_role: "viewer",
        kind: "offer",
        payload: { sdp: "v=0..." },
      }),
    ).rejects.toThrow("MIRROR_SESSION_NOT_ACTIVE");

    // Even if source tries to enable remote control when not requested, stays view-only
    const active = await respondMirrorConsent(db as never, OWNER, {
      session_id: created.session_id,
      accept: true,
      allow_remote_control: true,
    });
    expect(active.status).toBe("active");
    expect(active.mode).toBe("view_only");
    expect(active.remote_control_enabled).toBe(false);

    // Remote control command refused on view-only session
    await expect(
      postMirrorSignal(db as never, OWNER, {
        session_id: created.session_id,
        from_role: "viewer",
        kind: "remote_command",
        payload: { key: "Enter" },
      }),
    ).rejects.toThrow("REMOTE_CONTROL_DISABLED");

    // Normal SDP/ICE signaling succeeds
    const sig = await postMirrorSignal(db as never, OWNER, {
      session_id: created.session_id,
      from_role: "source",
      kind: "offer",
      payload: { sdp: "v=0\r\n" },
    });
    expect(sig.signal_id).toBeTruthy();

    // Stop immediately revokes session and blocks further signals
    await stopMirrorSession(db as never, OWNER, { session_id: created.session_id });
    await expect(
      postMirrorSignal(db as never, OWNER, {
        session_id: created.session_id,
        from_role: "source",
        kind: "ice",
        payload: {},
      }),
    ).rejects.toThrow("MIRROR_SESSION_NOT_ACTIVE");
  });

  it("manages reminders, device commands, and registers Jarvis tools in toolRegistry", async () => {
    const db = makeFakeFirestore();
    const laptop = await registerParentDevice(db as never, OWNER, {
      client_id: "desktop-client-id-123456",
      device_name: "Windows Desktop",
      device_type: "desktop",
      platform: "windows",
    });

    const rem = await createReminder(db as never, OWNER, { title: "Review PRs" });
    expect((await listReminders(db as never, OWNER)).length).toBe(1);
    await expect(completeReminder(db as never, OTHER, rem.id, true)).rejects.toThrow("NOT_FOUND");
    const done = await completeReminder(db as never, OWNER, rem.id, true);
    expect(done.status).toBe("completed");

    const queued = await queueDeviceCommand(db as never, OWNER, {
      target_device_id: laptop.id,
      command: "open_app",
      args: { app_name: "notepad" },
    });
    const polled = await pollDeviceCommands(db as never, OWNER, laptop.id);
    expect(polled.length).toBe(1);
    expect(polled[0].command_id).toBe(queued.command_id);

    const completed = await reportDeviceCommandResult(db as never, OWNER, {
      command_id: queued.command_id,
      ok: true,
      status: "executed",
      message: "Opened notepad",
    });
    expect(completed.status).toBe("executed");

    expect(toolRegistry.get("device.status")?.risk).toBe("low");
    expect(toolRegistry.get("device.open_app")?.approvalRequired).toBe(true);
    expect(toolRegistry.get("device.media_control")?.approvalRequired).toBe(true);
    expect(toolRegistry.get("reminders.create")?.risk).toBe("low");
    expect(toolRegistry.get("notifications.clear_history")?.risk).toBe("high");
  });
});
