import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Db } from "@/lib/firebase/admin";
import { verifyDeviceCredential, rpcDeviceScope } from "@/lib/firebase/device-session";
import {
  activeMirrorAndLockForUser,
  changeMemberRole,
  completeFamilyPairing,
  createFamily,
  createFamilyPairing,
  familyOverview,
  grantMirrorAccess,
  mirrorSessionStatus,
  reportFamilyActivity,
  requestParentAccess,
  setDeviceLock,
  setMirrorConsent,
  startMirrorSession,
  transferPrimary,
  updateMemberFeatures,
  uploadMirrorFrame,
} from "@/lib/server/family";
import { getOwnDeviceActivity, reportOwnDeviceActivity } from "@/lib/server/pairing";

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
    doc: (id = `doc${seqId++}abcdef12`) => makeRef(col, id),
    add: async (data: Record<string, unknown>) => {
      const id = `doc${seqId++}abcdef12`;
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

const parentUser = { uid: "parent-uid", email: "parent@example.com", emailVerified: true };
const childUser = { uid: "child-uid", email: "child@example.com", emailVerified: true };
const secondMember = { uid: "member2-uid", email: "member2@example.com", emailVerified: true };

async function makeValidMirrorPngDataUrl() {
  const buf = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 12, g: 24, b: 18 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

describe("Family supervision, cross-account devices, live mirror & remote lock", () => {
  it("pairs a child device across different accounts and authenticates its bearer credential", async () => {
    const { db, docs } = makeMockDb();
    docs.set("profiles/parent-uid", { full_name: "Ayesha Parent", email: parentUser.email });
    docs.set("profiles/child-uid", { full_name: "Rafi Child", email: childUser.email });

    const { family_id } = await createFamily(db, parentUser, { name: "Rahman Household" });
    const childMemberId = `${childUser.uid}_${family_id}`;
    docs.set(`family_members/${childMemberId}`, {
      user_id: childUser.uid,
      family_id,
      role: "child",
      is_primary: false,
      features: ["screen_time", "app_usage_view", "hidden_apps_view", "browser_history_view", "device_lock", "mirror_screen"],
      mirror_state: "never",
      revoked_at: null,
    });

    // Parent creates cross-account QR grant for child; child completes it from THEIR OWN account
    const grant = await createFamilyPairing(db, parentUser, { family_id, member_id: childMemberId });
    const token = grant.qr_payload.split(".").pop()!;
    const linked = await completeFamilyPairing(db, childUser, {
      pair_token: token,
      device_name: "Rafi Pixel 8",
      device_type: "phone",
      platform: "android",
    });

    // Bearer credential from family_devices resolves cleanly via verifyDeviceCredential
    const session = await verifyDeviceCredential(db, linked.access_token);
    expect(session?.uid).toBe(childUser.uid);
    expect(rpcDeviceScope("family_activity_report")).toBe("family:report");
    expect(rpcDeviceScope("family_mirror_frame_upload")).toBe("family:mirror");

    // Child device reports app usage, hidden apps & browser history
    await reportFamilyActivity(db, childUser, {
      device_id: linked.device_id,
      screen_time_minutes: 95,
      apps: [
        { name: "YouTube", package: "com.google.android.youtube", minutes: 60, hidden: false },
        { name: "Calculator Vault", package: "com.stealth.vault", minutes: 35, hidden: true },
      ],
      browser_history: [{ url: "https://khanacademy.org", title: "Khan Academy", visited_at: "2026-11-12T01:00:00Z" }],
    });

    const ov = await familyOverview(db, parentUser, family_id);
    const childSummary = ov.members.find((m) => m.user_id === childUser.uid)!;
    expect(childSummary.devices[0].device_name).toBe("Rafi Pixel 8");
    expect(childSummary.activity?.screen_time_minutes).toBe(95);
    expect(childSummary.activity?.hidden_apps).toHaveLength(1);
    expect(childSummary.activity?.hidden_apps[0].name).toBe("Calculator Vault");
    expect(childSummary.activity?.browser_history[0].title).toBe("Khan Academy");
  });

  it("enforces transparent screen mirroring banner, live frame upload, and parent re-grant after child disables", async () => {
    const { db, docs } = makeMockDb();
    docs.set("profiles/parent-uid", { full_name: "Mom", email: parentUser.email });
    const { family_id } = await createFamily(db, parentUser, { name: "Home" });
    const childMemberId = `${childUser.uid}_${family_id}`;
    docs.set(`family_members/${childMemberId}`, {
      user_id: childUser.uid,
      family_id,
      role: "child",
      is_primary: false,
      features: ["mirror_screen", "device_lock"],
      mirror_state: "never",
      revoked_at: null,
    });

    // Primary parent grants + child opts in
    await grantMirrorAccess(db, parentUser, { family_id, member_id: childMemberId });
    await setMirrorConsent(db, childUser, { family_id, consent: "grant" });

    const started = await startMirrorSession(db, parentUser, { family_id, member_id: childMemberId });

    // Child's device immediately sees active mirror session banner
    const banner = await activeMirrorAndLockForUser(db, childUser);
    expect(banner.active_sessions).toHaveLength(1);
    expect(banner.active_sessions[0].viewer_name).toBe("Mom");

    // Child streams a screenshot frame; parent retrieves it
    const frameUrl = await makeValidMirrorPngDataUrl();
    await uploadMirrorFrame(db, childUser, {
      session_id: started.session_id,
      image_data_url: frameUrl,
    });
    const view = await mirrorSessionStatus(db, parentUser, started.session_id);
    expect(view.status).toBe("active");
    expect(view.frames).toBe(1);
    expect(view.frame_data_url).toBe(frameUrl);

    // Child disables mirroring -> session ends AND parent cannot restart until re-granted
    await setMirrorConsent(db, childUser, { family_id, consent: "revoke" });
    await expect(startMirrorSession(db, parentUser, { family_id, member_id: childMemberId })).rejects.toMatchObject({
      code: "MIRROR_REVOKED_BY_CHILD",
    });

    // Remote device lock (Google Family Link style) + child unlock request
    await setDeviceLock(db, parentUser, {
      family_id,
      member_id: childMemberId,
      locked: true,
      reason: "Homework & bedtime",
    });
    const lockedBanner = await activeMirrorAndLockForUser(db, childUser);
    expect(lockedBanner.locked?.reason).toBe("Homework & bedtime");

    await requestParentAccess(db, childUser, {
      family_id,
      kind: "unlock_device",
      note: "Need 10 minutes for math upload",
    });
    await setDeviceLock(db, parentUser, { family_id, member_id: childMemberId, locked: false });
    expect((await activeMirrorAndLockForUser(db, childUser)).locked).toBeNull();
  });

  it("allows primary parent to make any member a parent and records own-device telemetry", async () => {
    const { db, docs } = makeMockDb();
    const { family_id } = await createFamily(db, parentUser, { name: "Team Family" });
    const m2Id = `${secondMember.uid}_${family_id}`;
    docs.set(`family_members/${m2Id}`, {
      user_id: secondMember.uid,
      family_id,
      role: "child",
      is_primary: false,
      features: [],
      revoked_at: null,
    });

    await changeMemberRole(db, parentUser, { family_id, member_id: m2Id, role: "parent" });
    expect(docs.get(`family_members/${m2Id}`)?.role).toBe("parent");

    await transferPrimary(db, parentUser, { family_id, member_id: m2Id });
    expect(docs.get(`family_members/${m2Id}`)?.is_primary).toBe(true);

    // Own-device activity report & retrieval
    await updateMemberFeatures; // keep import exercised
    await reportOwnDeviceActivity(db, parentUser, {
      device_id: "macbook-pro",
      device_name: "Work MacBook",
      platform: "macos-tauri",
      screen_time_minutes: 140,
      apps: [{ name: "VS Code", package: "com.microsoft.VSCode", minutes: 100, hidden: false }],
      hidden_apps: [{ name: ".daemon", package: "/tmp/.daemon", minutes: 5, hidden: true }],
      browser_history: [{ url: "https://developer.mozilla.org", title: "MDN", visited_at: "2026-11-12T02:00:00Z" }],
    });
    const own = await getOwnDeviceActivity(db, parentUser);
    expect(own).toHaveLength(1);
    expect(own[0].screen_time_minutes).toBe(140);
    expect(own[0].hidden_apps).toHaveLength(1);
    expect(own[0].browser_history[0].title).toBe("MDN");
  });
});
