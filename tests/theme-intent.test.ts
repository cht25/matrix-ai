import { describe, expect, it } from "vitest";
import { isThemeIntent } from "../src/lib/theme-intent";

describe("theme intent", () => {
  it("detects English and Bangla theme requests", () => {
    expect(isThemeIntent("Change your theme")).toBe(true);
    expect(isThemeIntent("show themes")).toBe(true);
    expect(isThemeIntent("থিম পরিবর্তন করো")).toBe(true);
    expect(isThemeIntent("make it midnight")).toBe(true);
  });

  it("ignores ordinary chat", () => {
    expect(isThemeIntent("Help me plan a study schedule")).toBe(false);
    expect(isThemeIntent("What is phishing?")).toBe(false);
  });
});
