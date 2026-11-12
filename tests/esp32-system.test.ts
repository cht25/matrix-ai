import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/firebase/admin";
import { ESP32_PROTOCOL_VERSION, esp32FirmwareSource } from "@/lib/esp32";
import {
  completeEsp32Pairing,
  createEsp32Pairing,
  listEsp32Nodes,
  reportEsp32Reading,
  revokeEsp32Node,
  updateEsp32Node,
} from "@/lib/server/esp32";

function makeMockDb() {
  const docs = new Map<string, Record<string, unknown>>();
  let seqId = 1;

  const makeRef = (col: string, id: string) => ({
    id,
    get: async () => ({
      id,
      exists: docs.has(`${col}/${id}`),
      data: () => docs.get(`${col}/${id}`),
      ref: makeRef(col, id),
    }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const key = `${col}/${id}`;
      docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : data);
    },
  });

  const makeQuery = (col: string, filters: Array<[string, string, unknown]> = [], max?: number) => ({
    where: (field: string, op: string, val: unknown) => makeQuery(col, [...filters, [field, op, val]], max),
    limit: (n: number) => makeQuery(col, filters, n),
    get: async () => {
      const matched: Array<{ id: string; data: () => Record<string, unknown>; ref: ReturnType<typeof makeRef> }> = [];
      for (const [k, v] of docs.entries()) {
        if (!k.startsWith(`${col}/`)) continue;
        const id = k.slice(col.length + 1);
        const ok = filters.every(([f, op, target]) => (op === "==" ? v[f] === target : true));
        if (ok) matched.push({ id, data: () => v, ref: makeRef(col, id) });
      }
      const sliced = typeof max === "number" ? matched.slice(0, max) : matched;
      return { empty: sliced.length === 0, docs: sliced };
    },
  });

  const collection = (col: string) => ({
    doc: (id = `doc${seqId++}abcdef`) => makeRef(col, id),
    add: async (data: Record<string, unknown>) => {
      const id = `doc${seqId++}abcdef`;
      docs.set(`${col}/${id}`, data);
      return { id };
    },
    where: (field: string, op: string, val: unknown) => makeQuery(col, [[field, op, val]]),
  });

  const db = {
    collection,
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        get: (ref: ReturnType<typeof makeRef>) => ref.get(),
        set: (ref: ReturnType<typeof makeRef>, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
          ref.set(data, opts),
      }),
  } as unknown as Db;

  return { db, docs };
}

const owner = { uid: "owner-1", email: "owner@example.com", emailVerified: true };

describe("ESP32 hardware bridge end-to-end", () => {
  it("pairs once, authenticates telemetry, enforces monotonic seq, and dispatches SOS alerts", async () => {
    const { db, docs } = makeMockDb();

    const grant = await createEsp32Pairing(db, owner, {
      label: "Desk Node",
      board: "esp32-s3",
      capabilities: ["check_in_button", "screen_time_lamp", "sos_alarm"],
    });
    expect(grant.qr_data_url).toMatch(/^data:image\/png;base64,/);

    const paired = await completeEsp32Pairing(db, {
      v: ESP32_PROTOCOL_VERSION,
      code: grant.pairing_code,
      label: "Study Lamp",
      board: "esp32-s3",
    });
    expect(paired.access_token).toMatch(/^matrix_esp32\./);

    // Reusing the single-use pairing code must fail
    await expect(
      completeEsp32Pairing(db, { v: ESP32_PROTOCOL_VERSION, code: grant.pairing_code }),
    ).rejects.toMatchObject({ code: "PAIRING_USED" });

    // Owner sets lamp brightness to 210
    await updateEsp32Node(db, owner, { id: paired.device_id, lamp: 210, focus_mode: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const report1 = await reportEsp32Reading(
      db,
      `Bearer ${paired.access_token}`,
      {
        v: ESP32_PROTOCOL_VERSION,
        device_id: paired.device_id,
        ts: nowSec,
        seq: 1,
        values: { presence: true },
        event: { type: "sos", message: "SOS button held" },
      },
      nowSec,
    );
    expect(report1).toEqual({ ok: true, lamp: 210, focus_mode: true, seq: 1 });

    // Anti-replay: repeating seq=1 is rejected
    await expect(
      reportEsp32Reading(
        db,
        `Bearer ${paired.access_token}`,
        { v: ESP32_PROTOCOL_VERSION, device_id: paired.device_id, ts: nowSec, seq: 1 },
        nowSec,
      ),
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" });

    // Notification created for SOS
    const notifs = [...docs.entries()].filter(([k]) => k.startsWith("notifications/"));
    expect(notifs.some(([, v]) => String(v.title).includes("SOS"))).toBe(true);

    const nodes = await listEsp32Nodes(db, owner);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].lamp).toBe(210);
    expect(nodes[0].last_event?.type).toBe("sos");

    await revokeEsp32Node(db, owner, paired.device_id);
    await expect(
      reportEsp32Reading(
        db,
        `Bearer ${paired.access_token}`,
        { v: ESP32_PROTOCOL_VERSION, device_id: paired.device_id, ts: nowSec, seq: 2 },
        nowSec,
      ),
    ).rejects.toMatchObject({ code: "ESP32_REVOKED" });
  });

  it("generates Arduino C++ firmware with forward prototype before readButton and balanced braces", () => {
    const sketch = esp32FirmwareSource({
      board: "esp32-devkit",
      capabilities: ["check_in_button", "screen_time_lamp", "sos_alarm", "presence_sensor"],
      endpoint: "https://matrix.example.com",
      pairingCode: "test-code-123456",
      label: "My ESP32",
      wifiSsid: "LabNet",
      wifiPassword: "secret",
    });

    const protoIdx = sketch.indexOf("void sendReading(const char* eventType, const char* message);");
    const readBtnIdx = sketch.indexOf("void readButton()");
    expect(protoIdx).toBeGreaterThan(0);
    expect(readBtnIdx).toBeGreaterThan(protoIdx);
    expect(sketch).toContain('WIFI_SSID       = "LabNet"');

    const opens = (sketch.match(/\{/g) ?? []).length;
    const closes = (sketch.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
