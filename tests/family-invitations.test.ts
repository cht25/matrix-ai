import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import type { Db } from "@/lib/firebase/admin";
import { acceptInvitation, revokeInvitation } from "@/lib/server/family";
import { escapeEmailHtml, familyInvitationUrl, sendFamilyInvitation } from "@/lib/server/family-email";

function fixture() {
  const token = "one-time-test-token";
  const docs = new Map<string, Record<string, unknown>>([
    ["family_invitations/i", { token_hash: crypto.createHash("sha256").update(token).digest("hex"), status: "pending", family_id: "f", invited_by: "parent", invitee_email: "child@example.com", expires_at: Timestamp.fromMillis(Date.now() + 60_000) }],
    ["family_members/parent_f", { role: "parent", revoked_at: null }],
  ]);
  const ref = (name: string, id: string) => ({ id,
    get: async () => ({ exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`) }),
    set: (value: Record<string, unknown>) => { docs.set(`${name}/${id}`, { ...docs.get(`${name}/${id}`), ...value }); },
  });
  const collection = (name: string) => ({
    doc: (id: string) => ref(name, id),
    add: async () => ({ id: "audit" }),
    where: (_key: string, _op: string, value: string) => ({ limit: () => ({ get: async () => ({ empty: value !== docs.get("family_invitations/i")?.token_hash, docs: [{ id: "i" }] }) }) }),
  });
  let lock: Promise<unknown> = Promise.resolve();
  const db = { collection, runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
    const next = lock.then(() => fn({ get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, v: Record<string, unknown>) => r.set(v) }));
    lock = next.catch(() => {});
    return next;
  } } as unknown as Db;
  return { db, docs, token };
}
const child = { uid: "child", email: "child@example.com", emailVerified: true };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("family invitation authorization and single use", () => {
  it("creates one membership when concurrent requests reuse the same token", async () => {
    const { db, docs, token } = fixture();
    const results = await Promise.allSettled([acceptInvitation(db, child, { token }), acceptInvitation(db, child, { token })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(docs.get("family_members/child_f")?.role).toBe("child");
    expect(docs.get("family_invitations/i")?.status).toBe("accepted");
  });
  it.each([{ ...child, email: "attacker@example.com" }, { ...child, emailVerified: false }])("rejects wrong or unverified email", async (user) => {
    const { db, docs, token } = fixture();
    await expect(acceptInvitation(db, user, { token })).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });
    expect(docs.has("family_members/child_f")).toBe(false);
  });
  it("rejects expired tokens", async () => {
    const { db, docs, token } = fixture();
    docs.get("family_invitations/i")!.expires_at = Timestamp.fromMillis(0);
    await expect(acceptInvitation(db, child, { token })).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
  });
  it("revocation prevents acceptance", async () => {
    const { db, token } = fixture();
    await revokeInvitation(db, { ...child, uid: "parent" }, "i");
    await expect(acceptInvitation(db, child, { token })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });
  it("nonparents cannot revoke invitations", async () => {
    const { db } = fixture();
    await expect(revokeInvitation(db, child, "i")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
  it("an invitation from a revoked parent cannot be accepted", async () => {
    const { db, docs, token } = fixture();
    docs.get("family_members/parent_f")!.revoked_at = Timestamp.now();
    await expect(acceptInvitation(db, child, { token })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });
});

describe("Resend integration", () => {
  const input = { id: "i", email: "child@example.com", token: "secret", expiresAt: "2026-11-06" };
  it("reports missing configuration without network requests", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await sendFamilyInvitation(input)).toEqual({ status: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("records provider acceptance, with stable idempotency and server-only auth", async () => {
    vi.stubEnv("RESEND_API_KEY", "server-secret"); vi.stubEnv("RESEND_FROM_EMAIL", "MATRIX <invite@example.com>");
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "email-id" }) }); vi.stubGlobal("fetch", fetch);
    expect(await sendFamilyInvitation(input)).toEqual({ status: "accepted_by_provider", provider_id: "email-id" });
    expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe("family-invitation/i");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer server-secret");
  });
  it("does not retry permanent provider errors or claim delivery", async () => {
    vi.stubEnv("RESEND_API_KEY", "key"); vi.stubEnv("RESEND_FROM_EMAIL", "invite@example.com");
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 422 }); vi.stubGlobal("fetch", fetch);
    expect(await sendFamilyInvitation(input)).toEqual({ status: "failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps invitation tokens out of URL query strings and escapes HTML", () => {
    const url = new URL(familyInvitationUrl("abc/+"));
    expect(url.search).toBe(""); expect(url.hash).toContain("invite=abc%2F%2B");
    expect(escapeEmailHtml('<a x="&">')).toBe("&lt;a x=&quot;&amp;&quot;&gt;");
  });
});
