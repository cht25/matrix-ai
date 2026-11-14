// Device hub: Parent / Child registration with approved QR pairing.
// Exercises the real server functions against an in-memory Firestore.
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_WINDOW_MS,
  CLAIM_WINDOW_MS,
  claimPairing,
  createParentPairing,
  decidePairing,
  deviceSelf,
  listHubDevices,
  listPairingRequests,
  registerParentDevice,
  requestPairing,
  revokeHubDevice,
  setDeviceConnection,
  updateDevice,
} from "@/lib/server/device-hub";
import { PAIRING_TTL_MS, listDevices } from "@/lib/server/pairing";
import { verifyDeviceCredential, hasDeviceScope } from "@/lib/firebase/device-session";
import { connectionStatus, describeUserAgent, formatManualCode, normalizeManualCode, sanitizePermissions } from "@/lib/devices/model";
import type { Db } from "@/lib/firebase/admin";

type DocData = Record<string, unknown>;
function makeDb() {
  const docs = new Map<string, DocData>();
  let counter = 0;
  const ref = (name: string, id: string) => {
    const k = `${name}/${id}`;
    const self = {
      id,
      get: async () => ({ id, exists: docs.has(k), data: () => docs.get(k), ref: self }),
      set: async (data: DocData, opts?: { merge?: boolean }) => {
        docs.set(k, opts?.merge ? { ...(docs.get(k) ?? {}), ...data } : { ...data });
      },
    };
    return self;
  };
  const db = {
    docs,
    collection: (name: string) => ({
      doc: (id?: string) => ref(name, id ?? `auto${String(++counter).padStart(12, "0")}`),
      add: async (data: DocData) => {
        const id = `auto${String(++counter).padStart(12, "0")}`;
        docs.set(`${name}/${id}`, data);
        return { id };
      },
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => {
          const matched = [...docs.entries()]
            .filter(([k, v]) => k.startsWith(`${name}/`) && v[field] === value)
            .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v, exists: true }));
          return { empty: matched.length === 0, docs: matched, size: matched.length };
        },
      }),
    }),
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: (r: { get: () => Promise<unknown> }) => r.get(),
        set: (r: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> }, data: DocData, opts?: { merge?: boolean }) => void r.set(data, opts),
      }),
  };
  return db;
}

const owner = { uid: "user-1", email: "a@example.com", emailVerified: true };
const stranger = { uid: "user-2", email: "b@example.com", emailVerified: true };
const CLIENT = "client-install-id-0001";
const phone = { device_name: "Pixel 8", device_type: "phone", platform: "android", os: "Android 15", app_version: "1.2.0" };

let raw: ReturnType<typeof makeDb>;
let d: Db;
let parentId: string;
beforeEach(async () => {
  process.env.DEVICE_PAIRING_SECRET = "test-pairing-secret-test-pairing-secret";
  raw = makeDb();
  d = raw as unknown as Db;
  parentId = (await registerParentDevice(d, owner, { client_id: CLIENT, device_name: "Chrome on Windows", device_type: "desktop", platform: "web", os: "Windows" })).id;
});

async function pairedChild(now = Date.now()) {
  const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
  const req = await requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone }, now);
  await decidePairing(d, owner, { challenge_id: req.challenge_id, approve: true }, now);
  const claim = await claimPairing(d, owner, { challenge_id: req.challenge_id, claim_secret: req.claim_secret }, now);
  if (claim.status !== "approved") throw new Error("expected approval");
  return { qr, req, claim };
}

describe("Parent registration", () => {
  it("registers this browser as a Parent once, idempotently, with no device credential", async () => {
    const again = await registerParentDevice(d, owner, { client_id: CLIENT, device_name: "Other name", device_type: "desktop", platform: "web" });
    expect(again.id).toBe(parentId);
    expect(again.role).toBe("parent");
    expect(again.device_name).toBe("Chrome on Windows");
    expect(raw.docs.get(`devices/${parentId}`)!.access_token_hash).toBeNull();
    const devices = await listHubDevices(d, owner, { current_device_id: parentId });
    expect(devices).toHaveLength(1);
    expect(devices[0].is_current).toBe(true);
  });

  it("refuses device credentials for every management action", async () => {
    const asDevice = { ...owner, deviceId: "dev-1", scopes: ["devices:write"] };
    await expect(registerParentDevice(d, asDevice, { client_id: CLIENT, device_name: "x", device_type: "phone", platform: "android" })).rejects.toMatchObject({ code: "DEVICE_SCOPE_DENIED" });
    await expect(createParentPairing(d, asDevice, { parent_device_id: parentId })).rejects.toMatchObject({ code: "DEVICE_SCOPE_DENIED" });
    await expect(decidePairing(d, asDevice, { challenge_id: "x", approve: true })).rejects.toMatchObject({ code: "DEVICE_SCOPE_DENIED" });
    await expect(revokeHubDevice(d, asDevice, parentId)).rejects.toMatchObject({ code: "DEVICE_SCOPE_DENIED" });
  });

  it("only a registered Parent device can generate a pairing QR", async () => {
    await expect(createParentPairing(d, owner, { parent_device_id: "nope" })).rejects.toMatchObject({ code: "PARENT_DEVICE_REQUIRED" });
    await expect(createParentPairing(d, stranger, { parent_device_id: parentId })).rejects.toMatchObject({ code: "PARENT_DEVICE_REQUIRED" });
  });
});

describe("QR generation", () => {
  it("issues a signed, expiring payload and a manual code, storing no secret in the QR", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    expect(qr.qr_payload).toMatch(/^matrix-pairing:v1\./);
    expect(qr.manual_code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(new Date(qr.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(PAIRING_TTL_MS);
    const stored = raw.docs.get(`pairing_challenges/${qr.challenge_id}`)!;
    expect(stored.flow).toBe("approval");
    expect(JSON.stringify(stored)).not.toContain(qr.manual_code); // only a hash is stored
    expect(qr.qr_payload).not.toContain(qr.manual_code);
  });
});

describe("Child registration and approval", () => {
  it("scan → request → approve → claim issues a working, scoped credential exactly once", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    const req = await requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone });
    expect(req.status).toBe("requested");

    // Nothing is usable before approval.
    expect(await claimPairing(d, owner, { challenge_id: req.challenge_id, claim_secret: req.claim_secret })).toEqual({ status: "requested" });
    expect((await listHubDevices(d, owner)).filter((x) => x.role === "child")).toHaveLength(0);

    const pending = await listPairingRequests(d, owner);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ device_name: "Pixel 8", platform: "android", os: "Android 15" });

    const decision = await decidePairing(d, owner, { challenge_id: req.challenge_id, approve: true, permissions: ["chat:read", "bogus:scope"] });
    expect(decision.status).toBe("approved");
    // Approved but not yet collected: not listed as a device anywhere.
    expect((await listHubDevices(d, owner)).filter((x) => x.role === "child")).toHaveLength(0);
    expect((await listDevices(d, owner.uid)).filter((x) => x.id === decision.device!.id)).toHaveLength(0);

    const claim = await claimPairing(d, owner, { challenge_id: req.challenge_id, claim_secret: req.claim_secret });
    if (claim.status !== "approved") throw new Error("expected approval");
    expect(claim.device.permissions).toEqual(["chat:read"]);
    expect(claim.parent).toEqual({ id: parentId, device_name: "Chrome on Windows" });

    const session = await verifyDeviceCredential(d, claim.access_token);
    expect(session).toMatchObject({ uid: owner.uid, deviceId: claim.device.id, scopes: ["chat:read"] });
    expect(hasDeviceScope(session!, "chat:read")).toBe(true);
    expect(hasDeviceScope(session!, "chat:write")).toBe(false);

    // The raw credential is never stored.
    expect(JSON.stringify([...raw.docs.values()])).not.toContain(claim.access_token.split(".")[2]);
    // Replay: the credential cannot be collected twice.
    await expect(claimPairing(d, owner, { challenge_id: req.challenge_id, claim_secret: req.claim_secret })).rejects.toMatchObject({ code: "PAIRING_USED" });

    const self = await deviceSelf(d, session!);
    expect(self.parent?.id).toBe(parentId);
    expect((await listHubDevices(d, owner)).find((x) => x.id === claim.device.id)?.status).toBe("online");
  });

  it("pairs with the manual code, in any spacing or case", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    const typed = formatManualCode(qr.manual_code).toLowerCase();
    const req = await requestPairing(d, owner, { manual_code: typed, ...phone });
    expect(req.challenge_id).toBe(qr.challenge_id);
    await expect(requestPairing(d, owner, { manual_code: "ZZZZ-ZZZZ", ...phone })).rejects.toMatchObject({ code: "PAIRING_INVALID" });
  });

  it("a denied request never yields a credential", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    const req = await requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone });
    expect((await decidePairing(d, owner, { challenge_id: req.challenge_id, approve: false })).status).toBe("denied");
    expect(await claimPairing(d, owner, { challenge_id: req.challenge_id, claim_secret: req.claim_secret })).toEqual({ status: "denied" });
    await expect(decidePairing(d, owner, { challenge_id: req.challenge_id, approve: true })).rejects.toMatchObject({ code: "PAIRING_NOT_PENDING" });
    expect((await listHubDevices(d, owner)).filter((x) => x.role === "child")).toHaveLength(0);
  });

  it("rejects an expired QR", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    await expect(requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone }, Date.now() + PAIRING_TTL_MS + 1000)).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });
    await expect(requestPairing(d, owner, { manual_code: qr.manual_code, ...phone }, Date.now() + PAIRING_TTL_MS + 1000)).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });
  });

  it("rejects a tampered QR and a second scan of the same QR", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    await expect(requestPairing(d, owner, { qr_payload: `${qr.qr_payload.slice(0, -2)}xx`, ...phone })).rejects.toMatchObject({ code: "PAIRING_INVALID" });
    await requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone });
    await expect(requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone })).rejects.toMatchObject({ code: "PAIRING_USED" });
  });

  it("another account can neither request, approve, nor claim", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    await expect(requestPairing(d, stranger, { qr_payload: qr.qr_payload, ...phone })).rejects.toMatchObject({ code: "PAIRING_ACCOUNT_MISMATCH" });
    const req = await requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone });
    await expect(decidePairing(d, stranger, { challenge_id: req.challenge_id, approve: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(claimPairing(d, stranger, { challenge_id: req.challenge_id, claim_secret: req.claim_secret })).rejects.toMatchObject({ code: "PAIRING_INVALID" });
  });

  it("a wrong claim secret cannot collect an approved credential", async () => {
    const qr = await createParentPairing(d, owner, { parent_device_id: parentId });
    const req = await requestPairing(d, owner, { qr_payload: qr.qr_payload, ...phone });
    await decidePairing(d, owner, { challenge_id: req.challenge_id, approve: true });
    await expect(claimPairing(d, owner, { challenge_id: req.challenge_id, claim_secret: "x".repeat(43) })).rejects.toMatchObject({ code: "PAIRING_INVALID" });
  });

  it("expires requests the Parent never answers and approvals never collected", async () => {
    const now = Date.now();
    const a = await createParentPairing(d, owner, { parent_device_id: parentId });
    const reqA = await requestPairing(d, owner, { qr_payload: a.qr_payload, ...phone }, now);
    await expect(decidePairing(d, owner, { challenge_id: reqA.challenge_id, approve: true }, now + APPROVAL_WINDOW_MS + 1)).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });

    const b = await createParentPairing(d, owner, { parent_device_id: parentId });
    const reqB = await requestPairing(d, owner, { qr_payload: b.qr_payload, ...phone }, now);
    await decidePairing(d, owner, { challenge_id: reqB.challenge_id, approve: true }, now);
    expect(await claimPairing(d, owner, { challenge_id: reqB.challenge_id, claim_secret: reqB.claim_secret }, now + CLAIM_WINDOW_MS + 1)).toEqual({ status: "expired" });
    expect((await listHubDevices(d, owner)).filter((x) => x.role === "child")).toHaveLength(0);
  });

  it("rate-limits pairing attempts per account", async () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) await requestPairing(d, owner, { manual_code: "ZZZZZZZZ", ...phone }, now).catch(() => {});
    await expect(requestPairing(d, owner, { manual_code: "ZZZZZZZZ", ...phone }, now)).rejects.toMatchObject({ code: "PAIRING_RATE_LIMITED" });
    await expect(requestPairing(d, owner, { manual_code: "ZZZZZZZZ", ...phone }, now + 6 * 60 * 1000)).rejects.toMatchObject({ code: "PAIRING_INVALID" });
  });
});

describe("Device management", () => {
  it("renames a device and changes permissions, enforced on the next request", async () => {
    const { claim } = await pairedChild();
    if (claim.status !== "approved") return;
    const updated = await updateDevice(d, owner, { device_id: claim.device.id, device_name: "Kitchen tablet", permissions: ["notifications:read"] });
    expect(updated.device_name).toBe("Kitchen tablet");
    const session = await verifyDeviceCredential(d, claim.access_token);
    expect(session!.scopes).toEqual(["notifications:read"]);
    await expect(updateDevice(d, owner, { device_id: parentId, permissions: [] })).rejects.toMatchObject({ code: "PARENT_PERMISSIONS_FIXED" });
    await expect(updateDevice(d, stranger, { device_id: claim.device.id, device_name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("disconnect refuses the credential; reconnect restores it", async () => {
    const { claim } = await pairedChild();
    if (claim.status !== "approved") return;
    expect((await setDeviceConnection(d, owner, { device_id: claim.device.id, connected: false })).status).toBe("disconnected");
    expect(await verifyDeviceCredential(d, claim.access_token)).toBeNull();
    await setDeviceConnection(d, owner, { device_id: claim.device.id, connected: true });
    expect(await verifyDeviceCredential(d, claim.access_token)).not.toBeNull();
  });

  it("revocation is immediate and permanent", async () => {
    const { claim } = await pairedChild();
    if (claim.status !== "approved") return;
    await revokeHubDevice(d, owner, claim.device.id);
    expect(await verifyDeviceCredential(d, claim.access_token)).toBeNull();
    expect((await listHubDevices(d, owner)).find((x) => x.id === claim.device.id)).toBeUndefined();
    await expect(setDeviceConnection(d, owner, { device_id: claim.device.id, connected: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("writes an audit entry for every step", async () => {
    const { claim } = await pairedChild();
    if (claim.status !== "approved") return;
    await revokeHubDevice(d, owner, claim.device.id);
    const actions = [...raw.docs.entries()].filter(([k]) => k.startsWith("audit_logs/")).map(([, v]) => v.action);
    for (const action of ["device.register_parent", "device.pairing_requested", "device.pairing_approved", "device.pair", "device.revoke"]) expect(actions).toContain(action);
  });
});

describe("Device model helpers", () => {
  it("derives status from real signals only", () => {
    const base = { revoked: false, suspended: false, credentialed: true, nowMs: 1_000_000 };
    expect(connectionStatus({ ...base, lastSeenMs: 990_000 })).toBe("online");
    expect(connectionStatus({ ...base, lastSeenMs: 1 })).toBe("offline");
    expect(connectionStatus({ ...base, lastSeenMs: 0 })).toBe("offline");
    expect(connectionStatus({ ...base, suspended: true, lastSeenMs: 990_000 })).toBe("disconnected");
    expect(connectionStatus({ ...base, revoked: true, lastSeenMs: 990_000 })).toBe("revoked");
  });
  it("normalises codes, permissions and user agents", () => {
    expect(normalizeManualCode("ab2c-9xyz ")).toBe("AB2C9XYZ");
    expect(formatManualCode("AB2C9XYZ")).toBe("AB2C-9XYZ");
    expect(sanitizePermissions(["chat:read", "chat:read", "admin:all", 4])).toEqual(["chat:read"]);
    expect(describeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toMatchObject({ device_type: "phone", os: "Android 14" });
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36").name).toBe("Chrome on Windows");
  });
});
