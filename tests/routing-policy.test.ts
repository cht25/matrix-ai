// =============================================================================
// Phase 5 — AI model routing.
//
// Pins the product contract:
//   • conversation → GPT OSS 120B, with GPT OSS 20B as the documented fallback;
//   • artifact/document generation → GLM 4.7 Flash on Cloudflare Workers AI;
//   • a manual model selection is never silently overridden;
//   • the model that actually answered is always reported, and a degraded
//     route says why.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { classifyRoute } from "../src/lib/ai/routing-policy";
import {
  CLOUDFLARE_MODEL_ID,
  CLOUDFLARE_MODEL_KEY,
  DEFAULT_MODEL_KEY,
  FALLBACK_MODEL_KEY,
  artifactModel,
  fallbackConversationModel,
  modelByKey,
  primaryConversationModel,
} from "../src/lib/ai/models/registry";
import { listModelStatus, resetModelHealthForTests, resolvePool } from "../src/lib/ai/models/pool";

const ok = () => Response.json({ data: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }] });

describe("Phase 5 — intent classification", () => {
  const cases: Array<[string, string | null, string]> = [
    ["Hello", null, "conversation"],
    ["What is the capital of France?", null, "conversation"],
    ["Explain React hooks", null, "conversation"],
    ["How do I build a website with React?", null, "conversation"],
    ["What is Python?", null, "conversation"],
    ["write a python function to reverse a string", null, "conversation"],
    ["Explain the difference between let and const", null, "conversation"],
    ["Build me a website for my bakery", null, "artifact"],
    ["Create a PDF report on climate change", null, "artifact"],
    ["Update my project to add a dark mode", null, "artifact"],
    ["Write a .html file that shows a clock", null, "artifact"],
    ["create a landing page", null, "artifact"],
    ["Scaffold a Next.js app with Firebase auth", null, "artifact"],
    ["Can you generate a dashboard for tracking expenses?", null, "artifact"],
    ["build a website", "agent", "artifact"],
    ["Generate an image of a robot", null, "image"],
    ["make a logo", null, "image"],
  ];

  it.each(cases)("classifies %j (mode %s) as %s", (message, mode, expected) => {
    expect(classifyRoute({ message, mode }).intent).toBe(expected);
  });

  it("is deterministic and side-effect free", () => {
    const a = classifyRoute({ message: "Build me a website" });
    const b = classifyRoute({ message: "Build me a website" });
    expect(a).toEqual(b);
  });

  it("explains itself without naming a provider credential", () => {
    const conversation = classifyRoute({ message: "hello" });
    const artifact = classifyRoute({ message: "create a PDF invoice" });
    expect(conversation.reason).toContain("GPT OSS 120B");
    expect(artifact.reason).toContain("GLM 4.7 Flash");
    expect(JSON.stringify([conversation, artifact])).not.toMatch(/gsk_|Bearer|token/i);
  });
});

describe("Phase 5 — registry tiers", () => {
  it("names the documented conversation primary and fallback", () => {
    expect(primaryConversationModel().key).toBe(DEFAULT_MODEL_KEY);
    expect(primaryConversationModel().tier).toBe("primary");
    expect(fallbackConversationModel()?.key).toBe(FALLBACK_MODEL_KEY);
    expect(fallbackConversationModel()?.id).toBe("openai/gpt-oss-20b");
  });

  it("names GLM 4.7 Flash as the artifact model with its exact catalog id", () => {
    expect(artifactModel()?.key).toBe(CLOUDFLARE_MODEL_KEY);
    expect(artifactModel()?.id).toBe(CLOUDFLARE_MODEL_ID);
    expect(artifactModel()?.tier).toBe("artifact");
  });
});

describe("Phase 5 — resolvePool", () => {
  beforeEach(() => {
    resetModelHealthForTests();
    vi.unstubAllEnvs();
    vi.stubEnv("GROQ_API_KEY", "gsk-routing-test");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetModelHealthForTests();
  });

  it("puts GPT OSS 120B first and GPT OSS 20B second for conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const pool = await resolvePool(null, null, null, { intent: "conversation" });
    expect(pool.targets[0]?.model).toBe("openai/gpt-oss-120b");
    expect(pool.targets[1]?.model).toBe("openai/gpt-oss-20b");
    expect(pool.degraded).toBeNull();
    expect(pool.manual).toBe(false);
  });

  it("records the degradation when artifact work cannot reach Cloudflare", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const pool = await resolvePool(null, null, null, { intent: "artifact" });
    expect(pool.degraded).not.toBeNull();
    expect(pool.degraded?.wanted).toBe("GLM 4.7 Flash");
    expect(pool.degraded?.used).toBe("GPT OSS 120B");
    expect(pool.targets[0]?.model).toBe("openai/gpt-oss-120b");
  });

  it("leads with GLM 4.7 Flash for artifact work when Cloudflare is configured", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-routing");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token-routing");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.cloudflare.com")) {
        return Response.json({ result: [{ name: CLOUDFLARE_MODEL_ID }], result_info: { total_pages: 1 } });
      }
      return ok();
    }));
    const statuses = await listModelStatus({ refresh: true });
    const glm = statuses.find((model) => model.key === CLOUDFLARE_MODEL_KEY);
    expect(glm?.availability).toBe("available");
    const pool = await resolvePool(null, null, null, { intent: "artifact" });
    expect(pool.targets[0]?.model).toBe(CLOUDFLARE_MODEL_ID);
    expect(pool.degraded).toBeNull();
  });

  it("honours a manual selection exactly — no silent override", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const pool = await resolvePool(null, null, { auto: false, enabled: ["gpt-oss-20b"] }, { intent: "artifact" });
    expect(pool.manual).toBe(true);
    expect(pool.targets.map((target) => target.model)).toEqual(["openai/gpt-oss-20b"]);
    expect(pool.degraded).toBeNull();
  });

  it("never substitutes GPT OSS for an explicit Cloudflare-only manual pool", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const pool = await resolvePool(null, null, { auto: false, enabled: [CLOUDFLARE_MODEL_KEY] }, { intent: "artifact" });
    expect(pool.targets).toEqual([]);
    expect(pool.skipped[0]?.key).toBe(CLOUDFLARE_MODEL_KEY);
  });

  it("reports an unavailable manual pick instead of swapping it silently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const pool = await resolvePool(null, null, { auto: false, enabled: ["qwen3-32b"] }, { intent: "conversation" });
    // The catalog above lists only the OSS models, so qwen is not offered.
    expect(pool.skipped.some((entry) => entry.key === "qwen3-32b")).toBe(true);
    expect(pool.degraded?.detail).toContain("not available");
  });
});

describe("Phase 5 — no credential is ever embedded in routing data", () => {
  it("keeps every target free of secrets", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-should-never-be-returned");
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const pool = await resolvePool(null, null, null, { intent: "conversation" });
    expect(JSON.stringify(pool.targets.map(({ client: _client, ...rest }) => rest))).not.toContain("gsk-");
  });
});
