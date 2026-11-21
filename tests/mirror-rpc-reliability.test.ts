import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotConfiguredError } from "../src/lib/data";

type Doc = Record<string, unknown>;

const store: Record<string, Record<string, Doc>> = {};
let nextCollectionFailures: Record<string, Error[]> = {};
let adminDbFactory: () => unknown;
let sessionCookieMap: Record<string, { uid: string; email: string | null }> = {};
let idTokenMap: Record<string, { uid: string; email: string | null }> = {};
let throwOnNextHeaders = false;

function col(name: string): Record<string, Doc> {
  return (store[name] ??= {});
}

function popFailure(collectionName: string): Error | undefined {
  const queue = nextCollectionFailures[collectionName];
  if (!queue || queue.length === 0) return undefined;
  return queue.shift();
}

function makeFakeDb() {
  return {
    collection(name: string) {
      const makeDocRef = (id: string) => ({
        id,
        async get() {
          const err = popFailure(name);
          if (err) throw err;
          const data = col(name)[id];
          return {
            exists: data !== undefined,
            id,
            ref: makeDocRef(id),
            data: () => data,
          };
        },
        async set(value: Doc, opts?: { merge?: boolean }) {
          col(name)[id] = opts?.merge ? { ...(col(name)[id] ?? {}), ...value } : value;
        },
        async update(patch: Doc) {
          col(name)[id] = { ...(col(name)[id] ?? {}), ...patch };
        },
        async delete() {
          delete col(name)[id];
        },
        collection(sub: string) {
          return makeFakeDb().collection(`${name}/${id}/${sub}`);
        },
      });

      const runQuery = async (predicate: (doc: Doc) => boolean) => {
        const err = popFailure(name);
        if (err) throw err;
        const docs = Object.entries(col(name))
          .filter(([, d]) => predicate(d))
          .map(([id, data]) => ({
            id,
            ref: makeDocRef(id),
            data: () => data,
          }));
        return { docs, empty: docs.length === 0, size: docs.length };
      };

      const makeFilteredQuery = (filters: Array<(doc: Doc) => boolean>) => ({
        where(field: string, op: string, value: unknown) {
          const nextPred = (doc: Doc) => {
            const actual = doc[field];
            if (op === "==") return actual === value;
            if (op === "in" && Array.isArray(value)) return value.includes(actual);
            return false;
          };
          return makeFilteredQuery([...filters, nextPred]);
        },
        limit() {
          return makeFilteredQuery(filters);
        },
        orderBy() {
          return makeFilteredQuery(filters);
        },
        get() {
          return runQuery((doc) => filters.every((fn) => fn(doc)));
        },
      });

      return {
        doc(id?: string) {
          return makeDocRef(id ?? `auto-${crypto.randomUUID()}`);
        },
        async add(value: Doc) {
          const id = `auto-${Object.keys(col(name)).length + 1}`;
          col(name)[id] = value;
          return makeDocRef(id);
        },
        where(field: string, op: string, value: unknown) {
          return makeFilteredQuery([]).where(field, op, value);
        },
        limit() {
          return makeFilteredQuery([]);
        },
        orderBy() {
          return makeFilteredQuery([]);
        },
        get() {
          return runQuery(() => true);
        },
      };
    },
  };
}

vi.mock("next/headers", () => ({
  headers: async () => {
    if (throwOnNextHeaders) {
      throw new Error("headers() was called outside a request scope");
    }
    return new Headers();
  },
  cookies: async () => {
    if (throwOnNextHeaders) {
      throw new Error("cookies() was called outside a request scope");
    }
    return { get: () => undefined };
  },
}));

vi.mock("@/lib/firebase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/firebase/admin")>();
  return {
    ...actual,
    adminConfigured: () => true,
    adminDb: () => adminDbFactory(),
    nowTs: () => new Date("2026-11-21T12:00:00.000Z"),
    toTs: (d: Date) => d,
    adminAuth: () => ({
      async verifySessionCookie(cookie: string) {
        const match = sessionCookieMap[cookie];
        if (!match) throw new Error("auth/session-cookie-revoked");
        return { uid: match.uid, email: match.email ?? undefined };
      },
      async verifyIdToken(token: string) {
        const match = idTokenMap[token];
        if (!match) throw new Error("auth/id-token-expired");
        return { uid: match.uid, email: match.email ?? undefined };
      },
    }),
  };
});

const { POST } = await import("../src/app/api/rpc/route");
const { redactRpcText } = await import("../src/lib/server/rpc-diagnostics");

function buildRpcRequest(
  body: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request("https://qorvyna.thamjj13.top/api/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://qorvyna.thamjj13.top",
      Host: "qorvyna.thamjj13.top",
      ...extraHeaders,
    },
    body,
  });
}

async function postRpc(
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const req = buildRpcRequest(JSON.stringify(payload), extraHeaders);
  const res = await POST(req as never);
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, body: json };
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  nextCollectionFailures = {};
  const fakeDb = makeFakeDb();
  adminDbFactory = () => fakeDb;
  sessionCookieMap = {
    "valid-new-user-cookie": { uid: "uid-new-user", email: "newuser@example.com" },
    "valid-existing-user-cookie": { uid: "uid-existing-user", email: "existing@example.com" },
  };
  idTokenMap = {
    "valid-existing-id-token": { uid: "uid-existing-user", email: "existing@example.com" },
  };
  throwOnNextHeaders = false;
});

describe("/mirror and /api/rpc end-to-end reliability", () => {
  it("rejects unauthenticated /mirror RPCs with 401 UNAUTHENTICATED and X-QORVYNA-Request-ID", async () => {
    const [devRes, sessRes] = await Promise.all([
      postRpc({ action: "device_list" }),
      postRpc({ action: "mirror_sessions_list" }),
    ]);

    for (const res of [devRes, sessRes]) {
      expect(res.status).toBe(401);
      const reqId = res.headers.get("x-qorvyna-request-id");
      expect(reqId).toBeTruthy();
      expect(res.body).toMatchObject({
        success: false,
        request_id: reqId,
        error: { code: "UNAUTHENTICATED", request_id: reqId },
      });
    }
  });

  it("never falls back to __session cookie when an explicit Bearer token is invalid", async () => {
    const res = await postRpc(
      { action: "device_list" },
      {
        Cookie: "__session=valid-existing-user-cookie",
        Authorization: "Bearer invalid-id-token",
      },
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("rejects cross-origin requests with 403 BAD_ORIGIN and attaches X-QORVYNA-Request-ID", async () => {
    const req = new Request("https://qorvyna.thamjj13.top/api/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
        Host: "qorvyna.thamjj13.top",
        Cookie: "__session=valid-new-user-cookie",
      },
      body: JSON.stringify({ action: "device_list" }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(403);
    expect(res.headers.get("x-qorvyna-request-id")).toBeTruthy();
  });

  it("handles new-user accounts (onboarding_complete=false, empty collections) across all /mirror RPCs", async () => {
    // Provisioned profile matching ensureUserDocuments defaults (date_of_birth: "").
    store.profiles = {
      "uid-new-user": {
        full_name: "New User",
        date_of_birth: "",
        age_verified: false,
        theme: "system",
      },
    };
    const authHeaders = { Cookie: "__session=valid-new-user-cookie" };

    const [devRes, mirrorRes, familyBannerRes, notifRes, onboardingRes, settingsRes] = await Promise.all([
      postRpc({ action: "device_list" }, authHeaders),
      postRpc({ action: "mirror_sessions_list" }, authHeaders),
      postRpc({ action: "family_mirror_active" }, authHeaders),
      postRpc({ action: "notifications_list" }, authHeaders),
      postRpc({ action: "onboarding_status" }, authHeaders),
      postRpc({ action: "settings_get" }, authHeaders),
    ]);

    expect(devRes.status).toBe(200);
    expect(devRes.body).toMatchObject({ success: true, data: [] });

    expect(mirrorRes.status).toBe(200);
    expect(mirrorRes.body).toMatchObject({ success: true, data: { sessions: [] } });

    expect(familyBannerRes.status).toBe(200);
    expect(familyBannerRes.body).toMatchObject({
      success: true,
      data: { active_sessions: [], locked: null },
    });

    expect(notifRes.status).toBe(200);
    expect(notifRes.body).toMatchObject({ success: true, data: [] });

    expect(onboardingRes.status).toBe(200);
    expect(onboardingRes.body).toMatchObject({
      success: true,
      data: { complete: false },
    });

    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body).toMatchObject({
      success: true,
      data: { onboarding_complete: false, full_name: "New User" },
    });
  });

  it("handles existing-user accounts with paired devices, active mirror sessions ({ sessions }), and mixed/corrupt timestamps without 500s", async () => {
    // Force next/headers to throw if called, proving POST /api/rpc reads req directly.
    throwOnNextHeaders = true;

    const futureIso = new Date(Date.now() + 10 * 60_000).toISOString();
    store.profiles = {
      "uid-existing-user": {
        full_name: "Existing User",
        date_of_birth: "2000-05-10",
        age_verified: true,
      },
    };
    store.identity_verifications = {
      "ver-1": {
        user_id: "uid-existing-user",
        verification_status: "approved",
      },
    };
    store.devices = {
      "dev-parent": {
        user_id: "uid-existing-user",
        role: "parent",
        device_name: "Primary Workstation",
        device_type: "windows",
        platform: "Windows 11",
        registered_at: "2026-11-20T10:00:00.000Z",
        last_seen_at: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 },
      },
      "dev-child": {
        user_id: "uid-existing-user",
        role: "child",
        device_name: "Pixel 9",
        device_type: "android",
        platform: "Android 15",
        access_token_hash: "hashed-token",
        registered_at: new Date("2026-11-21T08:00:00.000Z"),
        // Out-of-bounds corrupt timestamp must degrade safely to "" instead of throwing RangeError!
        last_seen_at: 9e20,
      },
      "dev-revoked": {
        user_id: "uid-existing-user",
        role: "child",
        device_name: "Old Phone",
        device_type: "android",
        access_token_hash: "hashed-old",
        revoked_at: "2026-11-19T00:00:00.000Z",
      },
    };
    store.mirror_sessions = {
      "sess-active": {
        owner_uid: "uid-existing-user",
        viewer_uid: "uid-existing-user",
        source_device_id: "dev-child",
        source_device_name: "Pixel 9",
        status: "streaming",
        remote_control_requested: true,
        remote_control_granted: true,
        created_at: { seconds: 1_763_720_000, nanoseconds: 0 },
        expires_at: futureIso,
      },
    };
    store.notifications = {
      "notif-1": {
        user_id: "uid-existing-user",
        type: "security",
        title: "Mirror session started",
        body: "Pixel 9 is sharing its screen.",
        link: "/mirror",
        created_at: "2026-11-21T11:55:00.000Z",
        read_at: new Date(NaN),
      },
    };

    const authHeaders = {
      Cookie: "__session=valid-existing-user-cookie",
      Authorization: "Bearer valid-existing-id-token",
      "X-QORVYNA-Request-ID": "req-mirror-existing-01",
    };

    const [devRes, mirrorRes, notifRes, settingsRes] = await Promise.all([
      postRpc({ action: "device_list" }, authHeaders),
      postRpc({ action: "mirror_sessions_list" }, authHeaders),
      postRpc({ action: "notifications_list" }, authHeaders),
      postRpc({ action: "settings_get" }, authHeaders),
    ]);

    expect(devRes.status).toBe(200);
    expect(devRes.headers.get("x-qorvyna-request-id")).toBe("req-mirror-existing-01");
    const devices = devRes.body.data as Array<{ id: string; last_active_at: string }>;
    expect(devices.map((d) => d.id)).toEqual(["dev-parent", "dev-child"]);
    expect(devices.find((d) => d.id === "dev-child")?.last_active_at).toBe("");

    expect(mirrorRes.status).toBe(200);
    const mirrorData = mirrorRes.body.data as {
      sessions: Array<{ session_id: string; status: string; expires_at: string }>;
    };
    expect(Array.isArray(mirrorData.sessions)).toBe(true);
    expect(mirrorData.sessions).toHaveLength(1);
    expect(mirrorData.sessions[0]).toMatchObject({
      session_id: "sess-active",
      status: "streaming",
      expires_at: futureIso,
    });

    expect(notifRes.status).toBe(200);
    const notifs = notifRes.body.data as Array<{ id: string; read_at: string | null; created_at: string }>;
    expect(notifs).toEqual([
      expect.objectContaining({
        id: "notif-1",
        read_at: null,
        created_at: "2026-11-21T11:55:00.000Z",
      }),
    ]);

    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body).toMatchObject({
      success: true,
      data: { onboarding_complete: true },
    });
  });

  it("rejects non-object JSON bodies (null, array, primitive) with 400 BAD_REQUEST instead of crashing with 500 TypeError", async () => {
    for (const rawBody of ["null", "[]", '"device_list"', "123", "{malformed"]) {
      const req = buildRpcRequest(rawBody, {
        Cookie: "__session=valid-existing-user-cookie",
      });
      const res = await POST(req as never);
      expect(res.status, `body=${rawBody}`).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toMatchObject({
        success: false,
        error: { code: "BAD_REQUEST" },
      });
      expect(res.headers.get("x-qorvyna-request-id")).toBeTruthy();
    }
  });

  it("retries read-only /mirror RPCs once on transient Firestore 14 UNAVAILABLE transport errors", async () => {
    const transientDevicesErr = Object.assign(new Error("14 UNAVAILABLE: HTTP/2 stream closed (RST_STREAM)"), {
      code: 14,
    });
    const transientMirrorErr = Object.assign(new Error("14 UNAVAILABLE: Connection reset by peer"), {
      code: 14,
    });
    nextCollectionFailures = {
      devices: [transientDevicesErr],
      mirror_sessions: [transientMirrorErr],
    };

    const authHeaders = { Cookie: "__session=valid-existing-user-cookie" };
    const [devRes, mirrorRes] = await Promise.all([
      postRpc({ action: "device_list" }, authHeaders),
      postRpc({ action: "mirror_sessions_list" }, authHeaders),
    ]);

    expect(devRes.status).toBe(200);
    expect(devRes.body).toMatchObject({ success: true, data: [] });
    expect(mirrorRes.status).toBe(200);
    expect(mirrorRes.body).toMatchObject({ success: true, data: { sessions: [] } });
  });

  it("maps NotConfiguredError from adminDb() to 503 FIREBASE_NOT_CONFIGURED instead of an unhandled crash", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      adminDbFactory = () => {
        throw new NotConfiguredError();
      };
      const res = await postRpc(
        { action: "device_list" },
        { Cookie: "__session=valid-existing-user-cookie" },
      );
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: "FIREBASE_NOT_CONFIGURED" },
      });
    } finally {
      errSpy.mockRestore();
    }
  });

  it("emits structured error logs with request_id and scrubs all credentials, tokens, keys, cookies, and emails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sensitiveErr = Object.assign(
        new Error(
          "9 FAILED_PRECONDITION: query failed for user alice.secret@example.com " +
            "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl " +
            "cookie=__session=super-secret-cookie-value " +
            "device=matrix_device.dev123.secret987 " +
            "apiKey=sk-live-1234567890abcdef " +
            "-----BEGIN PRIVATE KEY-----MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw-----END PRIVATE KEY-----",
        ),
        { code: 9 },
      );
      nextCollectionFailures = {
        mirror_sessions: [sensitiveErr],
      };

      const res = await postRpc(
        { action: "mirror_sessions_list" },
        {
          Cookie: "__session=valid-existing-user-cookie",
          "X-QORVYNA-Request-ID": "req-redaction-check-99",
        },
      );

      expect(res.status).toBe(500);
      expect(res.headers.get("x-qorvyna-request-id")).toBe("req-redaction-check-99");
      // Client response never leaks internal details.
      const serializedClient = JSON.stringify(res.body);
      expect(serializedClient).not.toContain("FAILED_PRECONDITION");
      expect(serializedClient).not.toContain("alice.secret@example.com");
      expect(serializedClient).not.toContain("super-secret-cookie-value");

      expect(errSpy).toHaveBeenCalledTimes(1);
      const [, logPayload] = errSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(logPayload).toMatchObject({
        event: "rpc_failure",
        route: "/api/rpc",
        request_id: "req-redaction-check-99",
        action: "mirror_sessions_list",
        http_status: 500,
        error_code: "INTERNAL",
        category: "upstream_index",
        upstream_code: "GRPC_9_FAILED_PRECONDITION",
        authenticated: true,
        via_device_token: false,
      });

      const serializedLog = JSON.stringify(logPayload);
      expect(serializedLog).not.toContain("alice.secret@example.com");
      expect(serializedLog).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
      expect(serializedLog).not.toContain("super-secret-cookie-value");
      expect(serializedLog).not.toContain("secret987");
      expect(serializedLog).not.toContain("sk-live-1234567890abcdef");
      expect(serializedLog).not.toContain("MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw");
      expect( redactRpcText("email user@domain.org") ).toBe("email [redacted-email]");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("propagates request_id from /api/rpc error responses onto client RpcCallError", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const { rpc, RpcCallError } = await import("../src/lib/client/api");
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(
          typeof input === "string" ? `https://qorvyna.thamjj13.top${input}` : input,
          {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string>),
              Origin: "https://qorvyna.thamjj13.top",
              Host: "qorvyna.thamjj13.top",
            },
          },
        );
        return POST(req as never);
      }) as typeof fetch;

      await expect(rpc("device_list")).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(RpcCallError);
        const rpcErr = err as InstanceType<typeof RpcCallError>;
        expect(rpcErr.code).toBe("UNAUTHENTICATED");
        expect(rpcErr.status).toBe(401);
        expect(typeof rpcErr.requestId).toBe("string");
        expect((rpcErr.requestId ?? "").length).toBeGreaterThanOrEqual(8);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
