import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeFirestore } from "./helpers/test-db";
import {
  classifyResendError,
  getEmailAdminStatus,
  refreshResendDomainHealth,
  resolveSenderCandidates,
  sendAppAlertEmail,
  sendDeviceDisconnectedEmail,
  sendNewDevicePairingEmail,
  sendPasswordResetNoticeEmail,
  sendSecurityAlertEmail,
  sendTransactionalEmail,
  sendWelcomeEmail,
} from "@/lib/server/email";

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_secret_value_12345";
  delete process.env.RESEND_FROM_PRIMARY;
  delete process.env.RESEND_FROM_FALLBACKS;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.PARENT_NOTIFICATION_EMAIL;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
});

describe("Phase 4 — Resend Dual-Sender Architecture & Failover", () => {
  it("resolves primary no-reply@qorvyna.top and default fallbacks in exact order", () => {
    const chain = resolveSenderCandidates();
    expect(chain.map((c) => [c.email, c.role])).toEqual([
      ["no-reply@qorvyna.top", "primary"],
      ["no-reply@matrix.thamjj13.top", "fallback"],
      ["no-reply@qorvyna.thamjj13.top", "fallback"],
    ]);
  });

  it("uses primary sender on first success and logs masked delivery metadata", async () => {
    const db = makeFakeFirestore();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "re_msg_primary_1" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await sendWelcomeEmail({
      db: db as never,
      userId: "u-1",
      email: "student@example.com",
      fullName: "Amina Rahman",
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe("accepted_by_provider");
    expect(res.sender_used).toBe("no-reply@qorvyna.top");
    expect(res.fallback_used).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(body.from).toContain("no-reply@qorvyna.top");
    expect(body.to).toEqual(["student@example.com"]);

    const status = await getEmailAdminStatus(db as never);
    expect(status.api_key_configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("re_test_secret_value_12345");
    expect(status.recent_logs[0].recipient_masked).toBe("st***@example.com");
    expect(status.senders[0].status).toBe("verified");
  });

  it("falls back automatically ONLY on unverified/disallowed sender domain errors", async () => {
    const db = makeFakeFirestore();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: "The qorvyna.top domain is not verified." }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ message: "Domain matrix.thamjj13.top is not verified yet." }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "re_msg_fb2" }),
      });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await sendSecurityAlertEmail({
      db: db as never,
      userId: "u-2",
      email: "user@example.com",
      eventId: "sec-1",
      title: "MFA Enabled",
      detail: "Two-factor security was turned on.",
    });

    expect(res.ok).toBe(true);
    expect(res.fallback_used).toBe(true);
    expect(res.requested_sender).toBe("no-reply@qorvyna.top");
    expect(res.sender_used).toBe("no-reply@qorvyna.thamjj13.top");
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Distinct idempotency keys per sender fallback so Resend does not cache prior 403
    const k0 = fetchSpy.mock.calls[0][1].headers["Idempotency-Key"];
    const k1 = fetchSpy.mock.calls[1][1].headers["Idempotency-Key"];
    const k2 = fetchSpy.mock.calls[2][1].headers["Idempotency-Key"];
    expect(k0).not.toBe(k1);
    expect(k1).not.toBe(k2);

    const status = await getEmailAdminStatus(db as never);
    expect(status.senders[0].status).toBe("unverified");
    expect(status.senders[1].status).toBe("unverified");
    expect(status.senders[2].status).toBe("verified");
  });

  it("NEVER triggers fallback on invalid API key (401), invalid recipient, rate limit (429), or 5xx outage", async () => {
    for (const scenario of [
      { status: 401, body: "Invalid API key", expectedCalls: 1, category: "invalid_api_key" },
      { status: 422, body: "Invalid recipient address suppressed", expectedCalls: 1, category: "invalid_recipient" },
      { status: 429, body: "Too many requests", expectedCalls: 3, category: "rate_limited" }, // retries SAME sender, never falls back
      { status: 503, body: "Upstream outage", expectedCalls: 3, category: "provider_outage" }, // 3 retries on SAME primary sender
    ]) {
      const db = makeFakeFirestore();
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: scenario.status,
        text: async () => scenario.body,
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const res = await sendTransactionalEmail({
        db: db as never,
        templateType: "app_alert",
        idempotencyKey: `err-${scenario.category}`,
        to: "bad@example.com",
        subject: "Test",
        text: "Hello",
        html: "<p>Hello</p>",
        retryBaseDelayMs: 0,
      });

      expect(res.ok).toBe(false);
      expect(res.error_category).toBe(scenario.category);
      expect(res.fallback_used).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(scenario.expectedCalls);
      for (const call of fetchSpy.mock.calls) {
        expect(JSON.parse(String(call[1].body)).from).toContain("no-reply@qorvyna.top");
      }
    }
  });

  it("deduplicates duplicate sends sharing the same idempotencyKey", async () => {
    const db = makeFakeFirestore();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "re_dedupe_1" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const first = await sendPasswordResetNoticeEmail({
      db: db as never,
      userId: "u-3",
      email: "user@example.com",
      eventId: "reset-99",
    });
    const second = await sendPasswordResetNoticeEmail({
      db: db as never,
      userId: "u-3",
      email: "user@example.com",
      eventId: "reset-99",
    });

    expect(first.status).toBe("accepted_by_provider");
    expect(second.status).toBe("deduplicated");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("probes Resend /domains honestly and never marks unverified domains as verified", async () => {
    const db = makeFakeFirestore();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { name: "qorvyna.top", status: "pending" },
          { name: "matrix.thamjj13.top", status: "verified" },
        ],
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const probe = await refreshResendDomainHealth(db as never);
    expect(probe.probed).toBe(true);
    expect(probe.domains_listed).toBe(2);

    const status = await getEmailAdminStatus(db as never);
    expect(status.senders[0].status).toBe("unverified");
    expect(status.senders[1].status).toBe("verified");
    expect(status.senders[2].status).toBe("unverified"); // domain absent in Resend /domains -> unverified, never verified
  });

  it("escapes untrusted HTML and excludes sensitive device/auth secrets in templates", async () => {
    const db = makeFakeFirestore();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "re_tpl_1" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await sendNewDevicePairingEmail({
      db: db as never,
      userId: "u-4",
      email: "owner@example.com",
      deviceId: "dev-1",
      deviceName: '<script>alert("xss")</script> Pixel 9',
      platform: "android",
    });
    await sendDeviceDisconnectedEmail({
      db: db as never,
      userId: "u-4",
      email: "owner@example.com",
      deviceId: "dev-1",
      deviceName: "Pixel 9",
      reason: "revoked",
      eventKey: "k1",
    });
    await sendAppAlertEmail({
      db: db as never,
      userId: "u-4",
      email: "owner@example.com",
      alertId: "al-1",
      title: "Build Done",
      detail: "Completed successfully",
    });

    const htmlBody = JSON.parse(String(fetchSpy.mock.calls[0][1].body)).html as string;
    expect(htmlBody).not.toContain("<script>");
    expect(htmlBody).toContain("&lt;script&gt;");
    expect(classifyResendError(422, "Invalid `to` address")).toEqual({
      category: "invalid_recipient",
      code: "RESEND_INVALID_RECIPIENT",
    });
  });
});
