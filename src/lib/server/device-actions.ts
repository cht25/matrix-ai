// =============================================================================
// QORVYNA AI — Device Action Commands & Jarvis Reminders (server-only).
//
// Powers permission-controlled device tools (open_app, media_control,
// dismiss_notification, device status, reminders) with explicit confirmation
// before external/sensitive execution and honest OS outcome tracking.
// =============================================================================

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";

const REMINDERS = "reminders";
const COMMANDS = "device_commands";
const DEVICES = "devices";
const COMMAND_TTL_MS = 10 * 60_000;

export type DeviceCommandType = "open_app" | "media_control" | "dismiss_notification" | "device_status_ping";

const millis = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const ts = v as { toMillis?: () => number; _seconds?: number; seconds?: number } | null | undefined;
  if (typeof ts?.toMillis === "function") return Number(ts.toMillis());
  if (typeof ts?._seconds === "number") return ts._seconds * 1000;
  if (typeof ts?.seconds === "number") return ts.seconds * 1000;
  return 0;
};
const iso = (v: unknown): string => {
  const m = millis(v);
  return m ? new Date(m).toISOString() : "";
};
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function createReminder(
  d: Db,
  user: SessionUser,
  input: { title: string; due_at?: string | null; note?: string; target_device_id?: string | null },
) {
  const title = clean(input.title, 160);
  if (!title) throw new RpcError("BAD_REQUEST", 400);
  let dueTs: Timestamp | null = null;
  if (input.due_at) {
    const parsed = new Date(input.due_at);
    if (Number.isNaN(parsed.getTime())) throw new RpcError("INVALID_DUE_DATE", 400);
    dueTs = Timestamp.fromDate(parsed);
  }
  const ref = d.collection(REMINDERS).doc();
  await ref.set({
    user_id: user.uid,
    title,
    note: clean(input.note, 400),
    due_at: dueTs,
    target_device_id: input.target_device_id ? clean(input.target_device_id, 128) : null,
    status: "pending",
    completed_at: null,
    created_at: nowTs(),
  });
  await d.collection("notifications").add({
    user_id: user.uid,
    type: "reminder",
    title: `Reminder set: ${title}`,
    body: dueTs ? `Scheduled for ${dueTs.toDate().toLocaleString()}` : "Saved to your QORVYNA reminders.",
    link: "/devices",
    read_at: null,
    delivery_channel: "in_app",
    created_at: nowTs(),
  }).catch(() => {});

  return {
    id: ref.id,
    title,
    due_at: dueTs ? dueTs.toDate().toISOString() : null,
    status: "pending",
  };
}

export async function listReminders(d: Db, user: SessionUser) {
  const snap = await d.collection(REMINDERS).where("user_id", "==", user.uid).get();
  return snap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: String(data.title ?? ""),
        note: String(data.note ?? ""),
        due_at: data.due_at ? iso(data.due_at) : null,
        status: String(data.status ?? "pending"),
        created_at: iso(data.created_at),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
}

export async function completeReminder(d: Db, user: SessionUser, reminderId: string, completed = true) {
  const ref = d.collection(REMINDERS).doc(reminderId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  await ref.set(
    {
      status: completed ? "completed" : "pending",
      completed_at: completed ? nowTs() : null,
    },
    { merge: true },
  );
  return { id: reminderId, status: completed ? "completed" : "pending" };
}

// ---------------------------------------------------------------------------
// Cross-Device Commands (permission & ownership checked)
// ---------------------------------------------------------------------------

export async function queueDeviceCommand(
  d: Db,
  user: SessionUser,
  input: {
    target_device_id: string;
    command: DeviceCommandType;
    args: Record<string, unknown>;
    requires_confirmation?: boolean;
  },
): Promise<{ command_id: string; status: "queued"; target_device_id: string; expires_at: string }> {
  const devSnap = await d.collection(DEVICES).doc(input.target_device_id).get();
  if (!devSnap.exists || devSnap.data()!.user_id !== user.uid || devSnap.data()!.revoked_at || devSnap.data()!.suspended_at) {
    throw new RpcError("DEVICE_NOT_AVAILABLE", 404);
  }
  const expiresMs = Date.now() + COMMAND_TTL_MS;
  const ref = d.collection(COMMANDS).doc();
  await ref.set({
    user_id: user.uid,
    target_device_id: input.target_device_id,
    requested_by_device_id: user.deviceId ?? "web",
    command: input.command,
    args: input.args,
    requires_confirmation: input.requires_confirmation !== false,
    status: "queued",
    outcome_message: "",
    expires_at: Timestamp.fromMillis(expiresMs),
    completed_at: null,
    created_at: nowTs(),
  });
  return {
    command_id: ref.id,
    status: "queued",
    target_device_id: input.target_device_id,
    expires_at: new Date(expiresMs).toISOString(),
  };
}

export async function pollDeviceCommands(d: Db, user: SessionUser, targetDeviceId?: string) {
  const devId = user.deviceId ?? targetDeviceId;
  if (!devId) return [];
  const snap = await d.collection(COMMANDS).where("user_id", "==", user.uid).get();
  const nowMs = Date.now();
  return snap.docs
    .filter((doc) => {
      const data = doc.data();
      return data.target_device_id === devId && data.status === "queued" && millis(data.expires_at) > nowMs;
    })
    .map((doc) => {
      const data = doc.data();
      return {
        command_id: doc.id,
        command: String(data.command ?? ""),
        args: (data.args ?? {}) as Record<string, unknown>,
        requires_confirmation: Boolean(data.requires_confirmation),
        created_at: iso(data.created_at),
      };
    });
}

export async function reportDeviceCommandResult(
  d: Db,
  user: SessionUser,
  input: { command_id: string; ok: boolean; status?: "executed" | "not_supported" | "permission_denied" | "failed"; message: string },
) {
  const ref = d.collection(COMMANDS).doc(input.command_id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.user_id !== user.uid) throw new RpcError("NOT_FOUND", 404);
  if (user.deviceId && snap.data()!.target_device_id !== user.deviceId) throw new RpcError("PERMISSION_DENIED", 403);
  const status = input.status ?? (input.ok ? "executed" : "failed");
  await ref.set(
    {
      status,
      outcome_message: clean(input.message, 300),
      completed_at: nowTs(),
    },
    { merge: true },
  );
  return { command_id: input.command_id, status, message: clean(input.message, 300) };
}
