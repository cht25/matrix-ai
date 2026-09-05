import { describe, expect, it } from "vitest";
import { AGENT_STAGES, computeAnalytics, detectAgentTool, emptyAnalytics } from "../src/lib/ai/pipeline";
import { exportMarkdown, toPlainText } from "../src/lib/export/response-export";
import { isRealSecret } from "../src/lib/ai/image/provider";

describe("agent pipeline", () => {
  it("selects a code tool for build requests", () => {
    expect(detectAgentTool("Build a responsive website").tool).toBe("code.runtime");
  });

  it("computes real latency and token totals", () => {
    const started = Date.now() - 1000;
    const a = computeAnalytics({ started, promptTokens: 10, completionTokens: 20, agentSteps: AGENT_STAGES.length, toolsExecuted: 1 });
    expect(a.totalTokens).toBe(30);
    expect(a.totalLatencyMs).toBeGreaterThan(0);
    expect(emptyAnalytics().failures).toBe(0);
  });
});

describe("export desk", () => {
  it("preserves headings in markdown export", () => {
    expect(exportMarkdown("# Hello\n\n- one", "T")).toContain("# Hello");
    expect(toPlainText("**bold**")).toContain("bold");
  });
});

describe("image provider secrets", () => {
  it("never treats a missing or placeholder key as configured", () => {
    expect(isRealSecret("")).toBe(false);
    expect(isRealSecret(undefined)).toBe(false);
    expect(isRealSecret("YOUR-TOGETHER-KEY")).toBe(false);
    expect(isRealSecret("sk-...")).toBe(false);
    expect(isRealSecret("short")).toBe(false);
  });

  it("accepts a realistic key", () => {
    expect(isRealSecret("2f9c1a77b0e4d5316a8c9f0e1b2d3c4a5f6e7d8c9b0a1234")).toBe(true);
  });
});
