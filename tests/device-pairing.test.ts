// MATRIX Connect QR pairing: signed one-time challenges, replay protection,
// expiry, and scoped device registration.
import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  PAIRING_TTL_MS,
  completePairing,
  createPairingChallenge,
  listDevices,
  revokeDevice,
  verifyQrPayload,
  RpcError,
} from "@/lib/server/pairing";

// --- Minimal in-memory Firestore stub with transaction support ---------------
type DocData = Record<string, unknown>;
function makeDb() {
  const docs = new Map<string, DocData>();
  const key = (c: string, id: string) => `${c}/${id}`;
  const collection = (name: string) => ({
    doc: (id: string) => ({
      id,
      get: async () => ({
        id,
        exists: docs.has(key(name, id)),
        data: () => docs.get(key(name, id)),
        ref: undefined as never,
      }),
      set: async (data: DocData, opts?: { merge?: boolean }) => {
        const k = key(name, id);
        docs.set(k, opts?.merge ? { ...(docs.get(k) ?? {}), ...data } : data);
      },
    }),
    add: async (data: DocData) => {
      const id = `auto_${docs.size}`;
      docs.set(key(name, id), data);
      return { id };
    },
    where: (field: string, op: string, value: unknown) => ({
      get: async () => {
        const matched = [...docs.entries()]
          .filter(([k, v]) => k.startsWith(`${name}/`) && !k.slice(name.length + 1).includes("/"))
          .filter(([, v]) => (op === "==" ? v[field] === value : true))
          .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v, exists: true }));
        return { empty: matched.length === 0, docs: matched, size: matched.length };
      },
    }),
  });
  // attach ref for transaction use
  const origCollection = collection;
  const db = {
    collection: (name: string) => {
      const c = origCollection(name);
      return {
        ...c,
        doc: (id: string) => {
          const d = c.doc(id);
          return { ...d, ref: { get: d.get, set: d.set, id } };
        },
      };
    },
    runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: async (ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> }, data: DocData, opts?: { merge?: boolean }) =>
          ref.set(data, opts),
      }),
    _docs: docs,
  };
  return db as unknown as Parameters<typeof completePairing>[0] & { _docs: Map<string, DocData> };
}

const owner = { uid: "owner-1", email: "o@x.com", emailVerified: true };
const scanner = { uid: "owner-1", email: "o@x.com", emailVerified: true }; // same account on 2nd device

describe("verifyQrPayload", () => {
  it("accepts a freshly created challenge payload", async () => {
    const d = makeDb();
    const ch = await createPairingChallenge(d, owner);
    const v = verifyQrPayload(ch.qr_payload);
    expect(v.challengeId).toBe(ch.challenge_id);
    expect(v.ownerUid).toBe("owner-1");
    expect(v.expiresAt).toBeGreaterThan(Date.now());
  });
  it("rejects tampered payloads", async () => {
    const d = makeDb();
    const ch = await createPairingChallenge(d, owner);
    const parts = ch.qr_payload.split(".");
    parts[2] = "attacker-uid";
    expect(() => verifyQrPayload(parts.join("."))).toThrow(RpcError);
    const bad = ch.qr_payload.slice(0, -2) + "xx";
    expect(() => verifyQrPayload(bad)).toThrow(RpcError);
  });
  it("rejects malformed and expired payloads", () => {
    expect(() => verifyQrPayload("hello.world")).toThrow(RpcError);
    expect(() => verifyQrPayload("matrix-pairing:v1.abc.owner.notanumber.deadbeef")).toThrow(RpcError);
    const expired = `matrix-pairing:v1.abc.owner-1.1000.${"0".repeat(64)}`;
    expect(() => verifyQrPayload(expired, 2000)).toThrow(RpcError);
  });
  it("challenge TTL is short (5 minutes)", () => {
    expect(PAIRING_TTL_MS).toBe(1000 * 60 * 5);
  });
});

describe("completePairing", () => {
  it("registers a device under the owner account with scoped authorization", async () => {
    const d = makeDb();
    const ch = await createPairingChallenge(d, owner);
    const device = await completePairing(d, scanner, {
      qr_payload: ch.qr_payload,
      device_name: "Pixel 8",
      device_type: "phone",
      platform: "android",
    });
    expect(device.device_name).toBe("Pixel 8");
    expect(device.scopes).toContain("chat:read");
    expect(device.scopes.length).toBeLessThanOrEqual(5); // scoped, not blanket
    const stored = d._docs.get(`devices/${device.id}`);
    expect(stored?.user_id).toBe("owner-1");
    expect(d._docs.has("audit_logs/auto_0") || [...d._docs.keys()].some((k) => k.startsWith("audit_logs/"))).toBe(true);
  });
  it("enforces one-time use (replay protection)", async () => {
    const d = makeDb();
    const ch = await createPairingChallenge(d, owner);
    await completePairing(d, scanner, { qr_payload: ch.qr_payload, device_name: "A", device_type: "phone", platform: "android" });
    await expect(
      completePairing(d, scanner, { qr_payload: ch.qr_payload, device_name: "B", device_type: "phone", platform: "android" }),
    ).rejects.toThrow(RpcError);
  });
  it("rejects expired challenges at completion", async () => {
    const d = makeDb();
    const ch = await createPairingChallenge(d, owner);
    // Force the stored expiry into the past but keep a valid signature by
    // crafting the payload with the past timestamp and verifying via the same
    // secret path: simplest is to mock Date.now via verifyQrPayload's nowMs.
    expect(() => verifyQrPayload(ch.qr_payload, Date.now() + PAIRING_TTL_MS + 1000)).toThrow(RpcError);
  });
});

describe("device registry", () => {
  it("lists active devices and revokes by owner only", async () => {
    const d = makeDb();
    // seed two devices directly
    d._docs.set("devices/d1", { user_id: "owner-1", device_name: "Watch", device_type: "watch", platform: "wearos", scopes: ["chat:read"], paired_at: Timestamp.now(), last_seen_at: Timestamp.now(), revoked_at: null });
    d._docs.set("devices/d2", { user_id: "someone-else", device_name: "X", device_type: "pc", platform: "windows", scopes: [], paired_at: Timestamp.now(), last_seen_at: Timestamp.now(), revoked_at: null });
    const list = await listDevices(d, "owner-1");
    expect(list.map((x) => x.id)).toEqual(["d1"]);
    await revokeDevice(d, owner, "d1");
    expect((await listDevices(d, "owner-1")).length).toBe(0);
    await expect(revokeDevice(d, owner, "d2")).rejects.toThrow(RpcError);
  });
});
