// =============================================================================
// Deployment display helpers (§23, §36): the strings shown next to real state.
// =============================================================================

import { afterEach, describe, expect, it } from "vitest";
import {
  absoluteUrl,
  copyToClipboard,
  formatBytes,
  isHttpUrl,
  pluralize,
  relativeTime,
  shortUrl,
  timeOfDay,
} from "@/lib/deploy/format";

const NOW = Date.parse("2026-03-05T12:00:00.000Z");

describe("formatBytes", () => {
  it("scales and never invents size", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("relativeTime", () => {
  it("reads a stored ISO timestamp", () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("Just now");
    expect(relativeTime(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe("12 min ago");
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3 hours ago");
    expect(relativeTime(new Date(NOW - 26 * 3_600_000).toISOString(), NOW)).toBe("Yesterday");
    expect(relativeTime(new Date(NOW - 9 * 86_400_000).toISOString(), NOW)).toMatch(/Feb/);
  });

  it("returns an empty string for missing values instead of a fake date", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime("not a date", NOW)).toBe("");
  });

  it("never counts backwards for a future timestamp", () => {
    expect(relativeTime(new Date(NOW + 600_000).toISOString(), NOW)).toBe("Just now");
  });
});

describe("timeOfDay", () => {
  it("renders log timestamps as HH:MM:SS", () => {
    expect(timeOfDay(NOW)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(timeOfDay(null)).toBe("");
  });
});

describe("pluralize / shortUrl", () => {
  it("matches English singular and plural", () => {
    expect(pluralize(1, "file")).toBe("1 file");
    expect(pluralize(4, "file")).toBe("4 files");
    expect(pluralize(2, "deployment", "deployments")).toBe("2 deployments");
  });

  it("strips the protocol and truncates long addresses", () => {
    expect(shortUrl("https://matrix.app/s/my-cool-site/")).toBe("matrix.app/s/my-cool-site");
    expect(shortUrl(null)).toBe("");
    expect(shortUrl("https://matrix.app/s/" + "a".repeat(80), 20)).toHaveLength(20);
  });
});

describe("absoluteUrl", () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = originalWindow;
  });

  it("resolves a stored /s/<slug> against the browser origin", () => {
    (globalThis as Record<string, unknown>).window = { location: { origin: "https://matrix.app" } };
    expect(absoluteUrl("/s/my-site")).toBe("https://matrix.app/s/my-site");
    expect(absoluteUrl("https://elsewhere.test/x")).toBe("https://elsewhere.test/x");
  });

  it("leaves the value alone during server rendering", () => {
    delete (globalThis as Record<string, unknown>).window;
    expect(absoluteUrl("/s/my-site")).toBe("/s/my-site");
    expect(absoluteUrl("")).toBe("");
  });

  it("recognises http(s) only", () => {
    expect(isHttpUrl("https://matrix.app/s/x")).toBe(true);
    expect(isHttpUrl("/s/x")).toBe(true); // relative to the app origin
    expect(isHttpUrl("data:text/html,hi")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});

describe("copyToClipboard", () => {
  it("reports failure instead of throwing when the browser blocks the write", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: () => Promise.reject(new Error("blocked")) } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => {
          throw new Error("no DOM");
        },
      },
    });
    await expect(copyToClipboard("https://matrix.app/s/x")).resolves.toBe(false);
    await expect(copyToClipboard("")).resolves.toBe(false);
  });
});
