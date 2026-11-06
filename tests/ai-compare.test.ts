// /api/ai/compare request validation: lane allowlist, dedupe, cap, defaults.
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPARE_LANES, MAX_COMPARE_LANES, parseCompareLanes } from "@/lib/ai/compare";

describe("parseCompareLanes", () => {
  it("defaults to fast/balanced/reasoning", () => {
    expect(parseCompareLanes(undefined)).toEqual([...DEFAULT_COMPARE_LANES]);
    expect(parseCompareLanes("nonsense")).toEqual([...DEFAULT_COMPARE_LANES]);
  });
  it("filters invalid lanes and dedupes", () => {
    expect(parseCompareLanes(["fast", "fast", "bogus", "coding"])).toEqual(["fast", "coding"]);
  });
  it("rejects non-comparable lanes like image/vision/auto", () => {
    expect(parseCompareLanes(["image", "vision", "auto"])).toEqual([]);
  });
  it("caps at the maximum lane count", () => {
    expect(parseCompareLanes(["fast", "balanced", "reasoning", "coding"]).length).toBe(MAX_COMPARE_LANES);
  });
});
