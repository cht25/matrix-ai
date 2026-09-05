import { describe, expect, it } from "vitest";
import { isChatMode, suggestMode } from "../src/lib/ai/modes";
import { decideRoute, planOrchestrator } from "../src/lib/ai/router";

describe("matrix modes", () => {
  it("accepts specialized modes", () => {
    expect(isChatMode("study")).toBe(true);
    expect(isChatMode("health")).toBe(true);
    expect(isChatMode("nope")).toBe(false);
  });

  it("suggests without auto-switching", () => {
    expect(suggestMode("quiz me on newton", "general")).toBe("study");
    expect(suggestMode("explain recursion", "study")).toBeNull();
  });
});

describe("intelligent router", () => {
  it("routes code mode to coding lane", () => {
    const d = decideRoute({ mode: "code", message: "fix this react bug" });
    expect(d.coding).toBe(true);
    expect(d.lane).toBe("coding");
  });

  it("plans orchestrator subtasks from a real goal", () => {
    const tasks = planOrchestrator("I have a physics exam in 7 days. Create a study plan and a python example and a visual diagram.");
    expect(tasks.some((t) => t.mode === "study")).toBe(true);
    expect(tasks.some((t) => t.mode === "code")).toBe(true);
    expect(tasks.some((t) => t.mode === "image")).toBe(true);
  });
});
