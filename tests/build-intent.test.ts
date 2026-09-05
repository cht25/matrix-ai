// =============================================================================
// Build intent (§2, §25, §26): which chat messages are allowed to start a real
// pipeline, and which must stay plain conversation.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  buildActionsFor,
  detectBuildIntent,
  detectImageAssetRequest,
  planFromRequest,
  shouldRunBuildPipeline,
} from "@/lib/ai/build-intent";

const WITH_PROJECT = { projectFileCount: 3, agentMode: true };

function intent(text: string, context: Record<string, unknown> = {}) {
  return detectBuildIntent(text, context);
}

describe("detectBuildIntent — normal chat never triggers the pipeline", () => {
  for (const text of [
    "hi",
    "explain React hooks",
    "what is a deployment?",
    "how do I deploy a react app?",
    "can you explain this error?",
    "write me a poem about the sea",
    "thanks!",
    "what does `useEffect` do",
  ]) {
    it(`stays quiet for "${text}"`, () => {
      const result = intent(text, WITH_PROJECT);
      expect(result.build).toBe(false);
      expect(result.publish).toBe(false);
      expect(result.preview).toBe(false);
      expect(shouldRunBuildPipeline(result)).toBe(false);
    });
  }
});

describe("detectBuildIntent — explicit build requests", () => {
  it("builds a named website", () => {
    const result = intent("build a website for my coffee shop");
    expect(result.build).toBe(true);
    expect(result.publish).toBe(false);
    expect(shouldRunBuildPipeline(result)).toBe(true);
  });

  it("builds when the target is a pronoun and the conversation has context", () => {
    const result = intent("make it", { priorPlan: "Here is the plan: a landing page with hero, features and pricing.", agentMode: true });
    expect(result.build).toBe(true);
    expect(result.needsClarification).toBe(false);
    expect(result.signals).toContain("resolved from conversation context");
  });

  it("asks one clarifying question instead of deploying a guess", () => {
    const result = intent("make it", { projectFileCount: 0, priorPlan: null, agentMode: true });
    expect(result.explicit).toBe(true);
    expect(result.needsClarification).toBe(true);
    expect(result.build).toBe(false);
    expect(result.clarification).toMatch(/What should I build/);
    expect(shouldRunBuildPipeline(result)).toBe(false);
  });

  it("builds and publishes on request", () => {
    const result = intent("build this landing page and publish it", WITH_PROJECT);
    expect(result.build).toBe(true);
    expect(result.publish).toBe(true);
  });

  it("treats 'deploy this' as a publish of existing files", () => {
    const result = intent("deploy this", WITH_PROJECT);
    expect(result.publish).toBe(true);
    // Existing files are published as they are — no silent regeneration.
    expect(buildActionsFor(result)).toEqual({ build: false, publish: true, preview: false });
  });

  it("treats 'fix and publish' as a repair run", () => {
    const result = intent("fix it and publish", WITH_PROJECT);
    expect(result.fix).toBe(true);
    expect(result.publish).toBe(true);
    expect(buildActionsFor(result).build).toBe(true);
  });

  it("previews without publishing when only a preview is asked for", () => {
    const result = intent("preview the site", WITH_PROJECT);
    expect(result.preview).toBe(true);
    expect(result.publish).toBe(false);
    expect(buildActionsFor(result)).toEqual({ build: false, publish: false, preview: true });
  });

  it("agent mode alone is not permission to build", () => {
    const result = intent("what files do I have?", { mode: "agent", projectFileCount: 5 });
    expect(shouldRunBuildPipeline(result)).toBe(false);
  });
});

describe("detectBuildIntent — refusals win", () => {
  it("does not publish when told not to", () => {
    const result = intent("build the site but don't publish it", WITH_PROJECT);
    expect(result.publish).toBe(false);
    expect(shouldRunBuildPipeline(result)).toBe(false);
  });

  it("honours 'no deploy'", () => {
    const result = intent("just explain the code, no deploy", WITH_PROJECT);
    expect(result.build).toBe(false);
    expect(result.publish).toBe(false);
  });
});

describe("planFromRequest", () => {
  it("derives a title and a slug from the user's own words", () => {
    const plan = planFromRequest("Build a portfolio site for a photographer");
    expect(plan.title).toMatch(/Photographer/i);
    expect(plan.slug).toBe("portfolio-site-for-a-photographer");
    expect(plan.needsEntry).toBe(true);
  });

  it("falls back to a generic project when there is nothing to name", () => {
    const plan = planFromRequest("");
    expect(plan.slug).toBe("matrix-project");
  });
});

describe("detectImageAssetRequest", () => {
  it("detects a concrete image request", () => {
    expect(detectImageAssetRequest("generate a hero image for the landing page")).toBe(true);
    expect(detectImageAssetRequest("create images for the feature cards")).toBe(true);
  });

  it("does not spend credits for ordinary chat", () => {
    expect(detectImageAssetRequest("what is a hero section?")).toBe(false);
    expect(detectImageAssetRequest("explain the build errors")).toBe(false);
  });
});
