import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createPairingChallenge, completePairing, revokeDevice } from "@/lib/server/pairing";
import { verifyDeviceCredential, deviceCredentialHash, parseDeviceToken, hasDeviceScope, rpcDeviceScope } from "@/lib/firebase/device-session";
import type { Db } from "@/lib/firebase/admin";

const owner = { uid: "device-owner", email: "owner@example.com", emailVerified: true };
function fixture() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({ id: path.split("/").at(-1)!, get: async () => ({ exists: docs.has(path), data: () => docs.get(path), ref: ref(path) }), set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => { docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data); } });
  const collection = (name: string) => ({ doc: (id = `device-${docs.size}-abcdefgh`) => ref(`${name}/${id}`), add: async (data: Record<string, unknown>) => { docs.set(`${name}/audit-${docs.size}`, data); return { id: "audit" }; } });
  const db = { collection, runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, data: Record<string, unknown>, opts?: { merge?: boolean }) => r.set(data, opts) }) } as unknown as Db;
  return { db, docs };
}
describe("revocable device credentials", () => {
  it("issues a scoped credential once, stores only its hash, and revokes actual access", async () => {
    const { db, docs } = fixture();
    const challenge = await createPairingChallenge(db, owner);
    const paired = await completePairing(db, owner, { qr_payload: challenge.qr_payload, device_name: "Pixel", device_type: "phone", platform: "android" });
    expect(parseDeviceToken(paired.access_token)?.deviceId).toBe(paired.id);
    const device = docs.get(`devices/${paired.id}`)!;
    expect(JSON.stringify(device)).not.toContain(paired.access_token);
    expect(device.access_token_hash).toBe(deviceCredentialHash(paired.id, parseDeviceToken(paired.access_token)!.secret));
    const session = await verifyDeviceCredential(db, paired.access_token);
    expect(session?.uid).toBe(owner.uid);
    expect(hasDeviceScope(session!, "chat:write")).toBe(true);
    expect(hasDeviceScope(session!, "admin:write")).toBe(false);
    await revokeDevice(db, owner, paired.id);
    expect(await verifyDeviceCredential(db, paired.access_token)).toBeNull();
  });
  it("rejects tampering, expiry and unknown IDs; RPC defaults to deny", async () => {
    const { db, docs } = fixture();
    const challenge = await createPairingChallenge(db, owner);
    const paired = await completePairing(db, owner, { qr_payload: challenge.qr_payload, device_name: "Pixel", device_type: "phone", platform: "android" });
    expect(await verifyDeviceCredential(db, `${paired.access_token.slice(0, -1)}X`)).toBeNull();
    docs.get(`devices/${paired.id}`)!.access_token_expires_at = Timestamp.fromMillis(1);
    expect(await verifyDeviceCredential(db, paired.access_token)).toBeNull();
    expect(rpcDeviceScope("admin_set_role")).toBeNull();
    expect(rpcDeviceScope("conversation_list")).toBe("chat:read");
    expect(rpcDeviceScope("notifications_list")).toBe("notifications:read");
  });
});
