import { describe, expect, it } from "vitest";
import { AGENT_STAGES, computeAnalytics, detectAgentTool, emptyAnalytics } from "../src/lib/ai/pipeline";
import { exportMarkdown, exportPdfBytes, toPlainText } from "../src/lib/export/response-export";
import { isTogetherConfigured } from "../src/lib/ai/together";

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
    expect(exportPdfBytes("hello").length).toBeGreaterThan(20);
  });
});

describe("together config", () => {
  it("does not claim configured without a key", () => {
    const prev = process.env.TOGETHER_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    expect(isTogetherConfigured()).toBe(false);
    if (prev) process.env.TOGETHER_API_KEY = prev;
  });
});
