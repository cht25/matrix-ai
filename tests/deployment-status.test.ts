// =============================================================================
// Deployment state machine (§39) — the UI is only allowed to render states the
// backend can actually produce, and every state has honest copy.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  deploymentCopy,
  isActiveStatus,
  isLive,
  normalizeStatus,
} from "@/lib/deploy/status";

describe("canTransition", () => {
  it("walks the real lifecycle", () => {
    expect(canTransition("none", "queued")).toBe(true);
    expect(canTransition("queued", "building")).toBe(true);
    expect(canTransition("building", "deploying")).toBe(true);
    expect(canTransition("deploying", "live")).toBe(true);
    expect(canTransition("live", "unpublished")).toBe(true);
    expect(canTransition("live", "queued")).toBe(true);
  });

  it("refuses impossible jumps", () => {
    expect(canTransition("none", "live")).toBe(false);
    expect(canTransition("queued", "live")).toBe(false);
    expect(canTransition("unpublished", "live")).toBe(false);
    expect(canTransition("failed", "live")).toBe(false);
  });

  it("never re-activates an unpublished deployment", () => {
    expect(canTransition("unpublished", "deploying")).toBe(false);
  });

  it("throws with the offending pair for debugging", () => {
    expect(() => assertTransition("none", "live")).toThrow(/DEPLOYMENT_TRANSITION_INVALID/);
    expect(() => assertTransition("none", "building")).toThrow(/none->building/);
  });
});

describe("status helpers", () => {
  it("only in-flight states count as active", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("building")).toBe(true);
    expect(isActiveStatus("deploying")).toBe(true);
    expect(isActiveStatus("live")).toBe(false);
    expect(isActiveStatus("failed")).toBe(false);
  });

  it("live is the only state that may render a public URL", () => {
    expect(isLive("live")).toBe(true);
    expect(isLive("deploying")).toBe(false);
    expect(isLive("queued")).toBe(false);
  });
});

describe("deploymentCopy", () => {
  it("reports progress and never claims a link before it exists", () => {
    expect(deploymentCopy("deploying").label).toMatch(/Publishing/i);
    expect(deploymentCopy("deploying").tone).toBe("active");
    expect(deploymentCopy("live").label).toMatch(/Published/i);
    expect(deploymentCopy("live").glyph).toBe("✓");
    expect(deploymentCopy("failed").glyph).toBe("✕");
    expect(deploymentCopy("none").tone).toBe("neutral");
  });

  it("distinguishes an unpublished site from a never-deployed one", () => {
    expect(deploymentCopy("unpublished").label).not.toBe(deploymentCopy("none").label);
  });
});

describe("normalizeStatus", () => {
  it("maps legacy provider words onto the state machine", () => {
    expect(normalizeStatus("ready")).toBe("live");
    expect(normalizeStatus("active")).toBe("live");
    expect(normalizeStatus("publishing")).toBe("deploying");
    expect(normalizeStatus("uploading")).toBe("deploying");
    expect(normalizeStatus("LIVE").toString()).toBe("live");
  });

  it("treats anything unknown as failed rather than pretending success", () => {
    expect(normalizeStatus("who-knows")).toBe("failed");
    expect(normalizeStatus(null)).toBe("none");
    expect(normalizeStatus(undefined)).toBe("none");
    expect(normalizeStatus("")).toBe("none");
  });
});
