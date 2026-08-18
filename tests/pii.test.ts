import { describe, expect, it } from "vitest";
import { redactPII, containsCredentials, leakedPII } from "../supabase/functions/_shared/pii";

describe("PII redaction (spec §16)", () => {
  it("redacts emails", () => {
    const r = redactPII("Contact me at alex.t@example.com please");
    expect(r.safe).toBe(false);
    expect(r.redacted).toContain("[EMAIL]");
    expect(r.redacted).not.toContain("alex.t@example.com");
  });

  it("redacts phone numbers", () => {
    const r = redactPII("Call +1 555-123-4567 now");
    expect(r.redacted).toContain("[PHONE]");
  });

  it("redacts one-time codes and passwords", () => {
    const r = redactPII("My OTP is 482913 and password: hunter2secret");
    expect(r.redacted).toContain("[ONE_TIME_CODE]");
    expect(r.redacted).toContain("[PASSWORD]");
    expect(r.redacted).not.toContain("482913");
    expect(r.redacted).not.toContain("hunter2secret");
  });

  it("redacts payment cards and JWTs", () => {
    expect(redactPII("Card 4111 1111 1111 1111").redacted).toContain("[PAYMENT_CARD]");
    expect(
      redactPII("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c").redacted,
    ).toContain("[AUTH_TOKEN]");
  });

  it("redacts government IDs and addresses", () => {
    const r = redactPII("My birth certificate number is 1999-123456 and I live at 42 Baker Street, London");
    expect(r.redacted).toContain("[GOVERNMENT_ID]");
    expect(r.redacted).toContain("[ADDRESS]");
  });

  it("leaves safe messages untouched", () => {
    const r = redactPII("Is this email a phishing scam? It says I won a prize.");
    expect(r.safe).toBe(true);
    expect(r.redacted).toBe("Is this email a phishing scam? It says I won a prize.");
  });

  it("containsCredentials detects secrets", () => {
    expect(containsCredentials("my otp is 123456")).toBe(true);
    expect(containsCredentials("how do i report a scam")).toBe(false);
  });

  it("leakedPII detects echoes in AI responses", () => {
    const original = "my email is test@example.com";
    const leaks = leakedPII(original, "I see your email test@example.com is at risk");
    expect(leaks).toContain("test@example.com");
    expect(leakedPII(original, "I won't repeat your details")).toEqual([]);
  });
});
