import { describe, expect, it } from "vitest";
import { calculateAge, validateAgeForRegistration } from "../src/lib/utils";

describe("Age calculation & registration eligibility (spec §8, §64)", () => {
  it("calculates age from DOB", () => {
    const now = new Date("2026-08-18");
    expect(calculateAge("2015-08-18", now)).toBe(11);
    expect(calculateAge("2015-08-19", now)).toBe(10); // not yet 11
    expect(calculateAge("2008-08-18", now)).toBe(18);
  });

  it("rejects 10-year-olds", () => {
    const r = validateAgeForRegistration("2016-01-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DOB_TOO_YOUNG");
  });

  it("allows 11-year-olds", () => {
    const r = validateAgeForRegistration("2015-01-01");
    expect(r.ok).toBe(true);
  });

  it("allows 17-year-olds", () => {
    const r = validateAgeForRegistration("2009-01-01");
    expect(r.ok).toBe(true);
  });

  it("rejects 18-year-olds", () => {
    const r = validateAgeForRegistration("2008-01-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DOB_TOO_OLD");
  });

  it("rejects future dates", () => {
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const r = validateAgeForRegistration(future);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("DOB_FUTURE");
  });

  it("rejects missing/invalid DOB", () => {
    expect(validateAgeForRegistration("").ok).toBe(false);
    expect(validateAgeForRegistration("not-a-date").ok).toBe(false);
  });
});
