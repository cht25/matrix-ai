import { describe, expect, it } from "vitest";
import { hashIdentity, identityHashes, normalizeCertNumber, validateCertNumber } from "../src/lib/server/identity-number";

describe("birth certificate number", () => {
  it("normalises spaces and hyphens", () => {
    expect(normalizeCertNumber("ab-12 34")).toBe("AB1234");
  });

  it("rejects missing, short, and obvious fakes", () => {
    expect(validateCertNumber("").ok).toBe(false);
    expect(validateCertNumber("123")).toBeTruthy();
    expect(validateCertNumber("123").ok).toBe(false);
    expect(validateCertNumber("000000").ok).toBe(false);
    expect(validateCertNumber("123456").ok).toBe(false);
    expect(validateCertNumber("AAAAAA").ok).toBe(false);
  });

  it("accepts a plausible number", () => {
    const r = validateCertNumber("1990-BD-884421");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe("1990BD884421");
  });

  it("hashes with HMAC and never returns the raw number", () => {
    const hashes = identityHashes("unit-test-pepper-32-characters-min", "uid-1", "1990BD884421");
    expect(hashes.identity_hash).toHaveLength(64);
    expect(hashes.identity_hash_global).toHaveLength(64);
    expect(hashes.identity_last4).toBe("4421");
    expect(hashes.identity_hash).not.toContain("1990");
    expect(hashIdentity("unit-test-pepper-32-characters-min", "uid-1:1990BD884421")).toBe(hashes.identity_hash);
  });
});
