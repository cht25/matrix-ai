// =============================================================================
// MATRIX AI — ESP32 / hardware bridge server registry (server-only).
//
// Collections:
//   esp32_pairings/{id}   single-use 15m pairing codes (SHA-256 hashed)
//   esp32_devices/{id}    registered nodes, hashed bearer token, seq counter,
//                         lamp brightness (0-255), focus_mode, last reading
//   esp32_events/{id}     recent check-in / SOS / presence / focus events
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import {
  ESP32_BOARDS,
  ESP32_ONLINE_WINDOW_MS,
  ESP32_PROTOCOL_VERSION,
  isEsp32Board,
  isEsp32Capability,
  validateEsp32Payload,
  type Esp32BoardId,
  type Esp32Capability,
} from "@/lib/esp32";

const PAIRINGS = "esp32_pairings";
const NODES = "esp32_devices";
const EVENTS = "esp32_events";
const PAIRING_TTL_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = "matrix_esp32.";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function iso(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const ts = value as { toDate?: () => Date };
  return typeof ts.toDate === "function" ? ts.toDate().toISOString() : "";
}

function millis(value: unknown): number {
  const ts = value as { toMillis?: () => number };
  return typeof ts.toMillis === "function" ? ts.toMillis() : 0;
}

export type Esp32NodeSummary = {
  id: string;
  label: string;
  board: Esp32BoardId;
  board_label: string;
  capabilities: Esp32Capability[];
  family_id: string | null;
  lamp: number;
  focus_mode: boolean;
  last_seq: number;
  last_seen_at: string;
  online: boolean;
  last_values: Record<string, number | boolean | string>;
  last_event: { type: string; message: string; at: string } | null;
  paired_at: string;
};

export type Esp32PairingGrant = {
  pairing_id: string;
  pairing_code: string;
  qr_payload: string;
  qr_data_url: string;
  expires_at: string;
  label: string;
  board: Esp32BoardId;
  capabilities: Esp32Capability[];
};

export async function createEsp32Pairing(
  d: Db,
  user: SessionUser,
  input: {
    label?: string;
    board?: string;
    capabilities?: unknown;
    family_id?: string | null;
  },
): Promise<Esp32PairingGrant> {
  const board: Esp32BoardId = isEsp32Board(input.board) ? input.board : "esp32-devkit";
  const capabilities: Esp32Capability[] = Array.isArray(input.capabilities)
    ? input.capabilities.filter(isEsp32Capability)
    : ["check_in_button", "screen_time_lamp"];
  const label = (input.label ?? "").trim().slice(0, 64) || "MATRIX ESP32 node";
  const familyId = typeof input.family_id === "string" && input.family_id.trim() ? input.family_id.trim().slice(0, 120) : null;

  const code = crypto.randomBytes(18).toString("base64url");
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  const ref = d.collection(PAIRINGS).doc();
  await ref.set({
    owner_uid: user.uid,
    family_id: familyId,
    label,
    board,
    capabilities,
    code_hash: sha256(code),
    status: "pending",
    expires_at: Timestamp.fromMillis(expiresAt),
    consumed_at: null,
    created_at: nowTs(),
  });

  const qrPayload = `${ESP32_PROTOCOL_VERSION}.pair.${code}`;
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 300, margin: 2 });
  return {
    pairing_id: ref.id,
    pairing_code: code,
    qr_payload: qrPayload,
    qr_data_url: qrDataUrl,
    expires_at: new Date(expiresAt).toISOString(),
    label,
    board,
    capabilities,
  };
}

export async function completeEsp32Pairing(
  d: Db,
  input: { v?: unknown; code?: unknown; label?: unknown; board?: unknown },
): Promise<{ device_id: string; access_token: string; protocol: string }> {
  if (input.v !== ESP32_PROTOCOL_VERSION) throw new RpcError("PROTOCOL_MISMATCH", 400);
  const rawCode = typeof input.code === "string" ? input.code.trim() : "";
  if (rawCode.length < 12 || rawCode.length > 128) throw new RpcError("PAIRING_INVALID", 400);

  const snap = await d.collection(PAIRINGS).where("code_hash", "==", sha256(rawCode)).limit(1).get();
  if (snap.empty) throw new RpcError("PAIRING_INVALID", 404);
  const pairingRef = d.collection(PAIRINGS).doc(snap.docs[0].id);
  const secret = crypto.randomBytes(32).toString("base64url");

  let ownerUid = "";
  let nodeLabel = "";
  const { deviceId } = await d.runTransaction(async (tx) => {
    const pSnap = await tx.get(pairingRef);
    const data = pSnap.data();
    if (!data || data.status !== "pending") throw new RpcError("PAIRING_USED", 409);
    if (Date.now() > millis(data.expires_at)) throw new RpcError("PAIRING_EXPIRED", 410);
    ownerUid = String(data.owner_uid ?? "");
    const board: Esp32BoardId = isEsp32Board(input.board)
      ? input.board
      : isEsp32Board(data.board)
        ? data.board
        : "esp32-devkit";
    nodeLabel =
      (typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 64) : "") ||
      String(data.label ?? "MATRIX ESP32 node");

    const nodeRef = d.collection(NODES).doc();
    const now = nowTs();
    tx.set(nodeRef, {
      owner_uid: ownerUid,
      family_id: data.family_id ?? null,
      label: nodeLabel,
      board,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities.filter(isEsp32Capability) : [],
      token_hash: sha256(`${nodeRef.id}.${secret}`),
      lamp: 0,
      focus_mode: false,
      last_seq: 0,
      last_values: {},
      last_event: null,
      paired_at: now,
      last_seen_at: now,
      revoked_at: null,
      created_at: now,
    });
    tx.set(pairingRef, { status: "consumed", consumed_at: now, device_id: nodeRef.id }, { merge: true });
    return { deviceId: nodeRef.id };
  });

  if (ownerUid) {
    await d.collection("notifications").add({
      user_id: ownerUid,
      type: "device",
      title: `ESP32 node paired: ${nodeLabel}`,
      body: "Your hardware node is online and connected to MATRIX.",
      link: "/devices",
      read_at: null,
      created_at: nowTs(),
    }).catch(() => {});
  }

  return {
    device_id: deviceId,
    access_token: `${TOKEN_PREFIX}${deviceId}.${secret}`,
    protocol: ESP32_PROTOCOL_VERSION,
  };
}

function parseBearer(header: string): { deviceId: string; secret: string } | null {
  const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim() ?? "";
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const deviceId = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(deviceId) || secret.length < 20) return null;
  return { deviceId, secret };
}

export async function reportEsp32Reading(
  d: Db,
  authHeader: string,
  payload: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; lamp: number; focus_mode: boolean; seq: number }> {
  const parsedToken = parseBearer(authHeader);
  if (!parsedToken) throw new RpcError("ESP32_UNAUTHORIZED", 401);

  const valid = validateEsp32Payload(payload, nowSeconds);
  if (!valid.ok) throw new RpcError(valid.code, 400);
  const bodyObj = payload as { device_id: string };
  if (bodyObj.device_id !== parsedToken.deviceId) throw new RpcError("DEVICE_ID_MISMATCH", 403);

  const nodeRef = d.collection(NODES).doc(parsedToken.deviceId);
  const expectedHash = sha256(`${parsedToken.deviceId}.${parsedToken.secret}`);

  let ownerUid = "";
  let familyId: string | null = null;
  let label = "ESP32 node";
  let lamp = 0;
  let focusMode = false;

  await d.runTransaction(async (tx) => {
    const snap = await tx.get(nodeRef);
    if (!snap.exists) throw new RpcError("ESP32_NOT_FOUND", 404);
    const data = snap.data()!;
    if (data.revoked_at) throw new RpcError("ESP32_REVOKED", 403);
    const storedHash = String(data.token_hash ?? "");
    const a = Buffer.from(expectedHash);
    const b = Buffer.from(storedHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new RpcError("ESP32_UNAUTHORIZED", 401);
    }
    const prevSeq = Number(data.last_seq ?? 0);
    if (valid.reading.seq <= prevSeq) throw new RpcError("REPLAY_DETECTED", 409);

    ownerUid = String(data.owner_uid ?? "");
    familyId = typeof data.family_id === "string" ? data.family_id : null;
    label = String(data.label ?? "ESP32 node");
    lamp = Number(data.lamp ?? 0);
    focusMode = data.focus_mode === true;
    if (valid.event?.type === "focus_toggle") {
      focusMode = !focusMode;
      lamp = focusMode ? 180 : 0;
    }

    const patch: Record<string, unknown> = {
      last_seq: valid.reading.seq,
      last_seen_at: nowTs(),
      focus_mode: focusMode,
      lamp,
      ...(valid.reading.values ? { last_values: valid.reading.values } : {}),
      ...(valid.event && valid.event.type !== "heartbeat"
        ? {
            last_event: {
              type: valid.event.type,
              message: valid.event.message ?? "",
              at: new Date(nowSeconds * 1000).toISOString(),
            },
          }
        : {}),
    };
    tx.set(nodeRef, patch, { merge: true });
  });

  if (valid.event && valid.event.type !== "heartbeat" && ownerUid) {
    await d.collection(EVENTS).add({
      device_id: parsedToken.deviceId,
      owner_uid: ownerUid,
      family_id: familyId,
      type: valid.event.type,
      message: valid.event.message ?? "",
      values: valid.reading.values ?? {},
      created_at: nowTs(),
    }).catch(() => {});

    if (valid.event.type === "sos" || valid.event.type === "check_in" || valid.event.type === "focus_toggle") {
      const title =
        valid.event.type === "sos"
          ? `SOS alert from ${label}`
          : valid.event.type === "check_in"
            ? `Check-in from ${label}`
            : `Focus mode ${focusMode ? "enabled" : "disabled"} on ${label}`;
      const body =
        valid.event.message ||
        (valid.event.type === "sos"
          ? "The SOS hardware button was held on your ESP32 node."
          : valid.event.type === "check_in"
            ? "Check-in button pressed on your ESP32 node."
            : `Focus mode is now ${focusMode ? "on" : "off"}.`);

      const recipients = new Set<string>([ownerUid]);
      if (familyId && (valid.event.type === "sos" || valid.event.type === "check_in")) {
        const famMembers = await d.collection("family_members").where("family_id", "==", familyId).get().catch(() => null);
        for (const doc of famMembers?.docs ?? []) {
          if (!doc.data().revoked_at && doc.data().role === "parent") {
            recipients.add(String(doc.data().user_id ?? ""));
          }
        }
      }
      for (const uid of recipients) {
        if (!uid) continue;
        await d.collection("notifications").add({
          user_id: uid,
          type: valid.event.type === "sos" ? "security" : "device",
          title,
          body,
          link: "/devices",
          read_at: null,
          created_at: nowTs(),
        }).catch(() => {});
      }
    }
  }

  return { ok: true, lamp, focus_mode: focusMode, seq: valid.reading.seq };
}

export async function listEsp32Nodes(d: Db, user: SessionUser): Promise<Esp32NodeSummary[]> {
  const snap = await d.collection(NODES).where("owner_uid", "==", user.uid).get();
  const now = Date.now();
  return snap.docs
    .filter((doc) => !doc.data().revoked_at)
    .map((doc) => {
      const data = doc.data();
      const board: Esp32BoardId = isEsp32Board(data.board) ? data.board : "esp32-devkit";
      const boardMeta = ESP32_BOARDS.find((item) => item.id === board) ?? ESP32_BOARDS[0];
      const lastSeenMs = millis(data.last_seen_at);
      return {
        id: doc.id,
        label: String(data.label ?? "ESP32 node"),
        board,
        board_label: boardMeta.label,
        capabilities: Array.isArray(data.capabilities) ? data.capabilities.filter(isEsp32Capability) : [],
        family_id: typeof data.family_id === "string" ? data.family_id : null,
        lamp: Math.max(0, Math.min(255, Number(data.lamp ?? 0))),
        focus_mode: data.focus_mode === true,
        last_seq: Number(data.last_seq ?? 0),
        last_seen_at: iso(data.last_seen_at),
        online: lastSeenMs > 0 && now - lastSeenMs <= ESP32_ONLINE_WINDOW_MS,
        last_values: data.last_values && typeof data.last_values === "object" ? (data.last_values as Record<string, number | boolean | string>) : {},
        last_event: data.last_event && typeof data.last_event === "object" ? (data.last_event as { type: string; message: string; at: string }) : null,
        paired_at: iso(data.paired_at),
      };
    })
    .sort((a, b) => b.paired_at.localeCompare(a.paired_at));
}

export async function updateEsp32Node(
  d: Db,
  user: SessionUser,
  input: { id: string; lamp?: number; focus_mode?: boolean; label?: string },
): Promise<{ ok: true }> {
  const ref = d.collection(NODES).doc(input.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.owner_uid !== user.uid || snap.data()?.revoked_at) {
    throw new RpcError("NOT_FOUND", 404);
  }
  const patch: Record<string, unknown> = { updated_at: nowTs() };
  if (typeof input.lamp === "number" && Number.isFinite(input.lamp)) {
    patch.lamp = Math.max(0, Math.min(255, Math.round(input.lamp)));
  }
  if (typeof input.focus_mode === "boolean") {
    patch.focus_mode = input.focus_mode;
  }
  if (typeof input.label === "string" && input.label.trim()) {
    patch.label = input.label.trim().slice(0, 64);
  }
  await ref.set(patch, { merge: true });
  return { ok: true };
}

export async function revokeEsp32Node(d: Db, user: SessionUser, id: string): Promise<{ ok: true }> {
  const ref = d.collection(NODES).doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.owner_uid !== user.uid) throw new RpcError("NOT_FOUND", 404);
  await ref.set({ revoked_at: nowTs() }, { merge: true });
  return { ok: true };
}
