import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import type { Db } from "@/lib/firebase/admin";
import { GLMProvider } from "@/lib/ai/glm";
import { decideRoute } from "@/lib/ai/router";
import { createAIRoutesFromDb, createScanRoutesFromDb } from "@/lib/ai/config";
import { environmentProviders } from "@/lib/ai/provider-registry";
import { glmImageProvider } from "@/lib/ai/image/glm-provider";
import { getImageProviderConfigPublic } from "@/lib/ai/image/config";
import { CompactStepsPill, ResponseProgress } from "@/components/response-status";
import { ChatClient } from "@/components/chat-client";
import {
  compareSemver,
  evaluateAppUpdate,
  saveAppReleaseConfig,
  SHIPPED_APP_RELEASE,
} from "@/lib/server/app-updates";
import { GET as getAppVersion } from "@/app/api/app/version/route";
import { PRODUCTION_CHAT_URL, PRODUCTION_ORIGIN, chatOriginUrl, siteOrigin } from "@/lib/seo";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Pillar 1 — GLM High-Load + gpt-oss-120b Low-Load Tiered Routing", () => {
  it("routes coding, web-dev, agent/build, deep study, and complex requests to HIGH tier (GLM)", () => {
    const coding = decideRoute({ mode: "general", message: "Build a Next.js landing page with Tailwind CSS and TypeScript" });
    expect(coding.tier).toBe("high");
    expect(coding.coding).toBe(true);

    const agent = decideRoute({ mode: "agent", message: "Inspect the repo and fix broken routes" });
    expect(agent.tier).toBe("high");

    const study = decideRoute({ mode: "study", message: "Teach me distributed consensus step by step" });
    expect(study.tier).toBe("high");

    const deepAnalysis = decideRoute({
      mode: "general",
      message: "Design a comprehensive distributed microservices architecture with zero-downtime trade-off analysis.",
    });
    expect(deepAnalysis.tier).toBe("high");
  });

  it("routes everyday lightweight chat to LOW tier (openai/gpt-oss-120b)", () => {
    const quickGreeting = decideRoute({ mode: "general", message: "Hey! How's your day going?" });
    expect(quickGreeting.tier).toBe("low");
    expect(quickGreeting.coding).toBe(false);

    const quickFact = decideRoute({ mode: "general", message: "What is the capital of Japan?" });
    expect(quickFact.tier).toBe("low");
  });

  it("prioritizes GLM for high-load & vision, gpt-oss-120b for low-load, and keeps secondary providers working", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-live-test-key");
    vi.stubEnv("GLM_MODEL", "glm-4.7");
    vi.stubEnv("GLM_VISION_MODEL", "glm-4.6v");
    vi.stubEnv("GROQ_API_KEY", "gsk-live-test-key");
    vi.stubEnv("GROQ_CHAT_MODEL", "openai/gpt-oss-120b");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-secondary-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secondary-key");
    vi.stubEnv("GEMINI_API_KEY", "AIza-explicit-only-key");

    const highTargets = await createAIRoutesFromDb(null, true, false, "high");
    expect(highTargets[0].provider).toBe("GLM");
    expect(highTargets[0].model).toBe("glm-4.7");
    expect(highTargets.some((t) => t.model === "openai/gpt-oss-120b")).toBe(true);

    const lowTargets = await createAIRoutesFromDb(null, false, false, "low");
    expect(lowTargets[0].model).toBe("openai/gpt-oss-120b");
    expect(lowTargets.some((t) => t.provider === "GLM")).toBe(true);
    // Gemini is never auto-injected into default routes.
    expect(lowTargets.some((t) => t.provider === "Gemini")).toBe(false);

    const scanTargets = await createScanRoutesFromDb(null);
    expect(scanTargets[0].provider).toBe("GLM");
    expect(scanTargets[0].model).toBe("glm-4.6v");

    // All other environment providers (OpenAI, Anthropic, Groq, GLM) remain registered & healthy.
    const registered = environmentProviders();
    expect(registered.map((p) => p.name)).toEqual(expect.arrayContaining(["GLM", "Groq", "OpenAI", "Anthropic"]));
  });

  it("GLMProvider streams clean output, strips chain-of-thought, and fires onReasoningActivity", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hidden internal draft" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Clean production answer." } }], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of sseChunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
    );

    const glm = new GLMProvider("glm-key", "https://open.bigmodel.cn/api/paas/v4");
    let reasoningSignals = 0;
    const tokens: string[] = [];
    for await (const tok of glm.streamChat({
      model: "glm-4.7",
      messages: [{ role: "user", content: "Write a clean function" }],
      onReasoningActivity: () => {
        reasoningSignals += 1;
      },
    })) {
      tokens.push(tok);
    }

    expect(reasoningSignals).toBeGreaterThanOrEqual(1);
    expect(tokens.join("")).toBe("Clean production answer.");
    expect(tokens.join("")).not.toContain("hidden internal draft");
  });
});

describe("Pillar 2 — GLM CogView Primary Image Generation", () => {
  it("defaults image configuration to GLM (cogview-4) and supports both b64_json and hosted URLs", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-image-key-1234");
    const emptyDb = {
      collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
    } as unknown as Db;
    const pub = await getImageProviderConfigPublic(emptyDb);
    expect(pub.provider).toBe("glm");
    expect(pub.configured).toBe(true);
    expect(pub.model).toBe("cogview-4");

    const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/images/generations")) {
        return new Response(
          JSON.stringify({ data: [{ url: "https://cdn.bigmodel.cn/generated/sample.png" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(pngBytes, { status: 200, headers: { "Content-Type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const generated = await glmImageProvider.generate(
      { apiKey: "glm-image-key-1234", model: "cogview-4" },
      "Futuristic emerald matrix skyline",
    );
    expect(generated.model).toBe("cogview-4");
    expect(generated.mime).toBe("image/png");
    expect(Buffer.from(generated.b64, "base64")).toEqual(Buffer.from(pngBytes));
  });
});

describe("Pillar 3 — Arena-Style Compact Collapsible Steps UI", () => {
  it("renders CompactStepsPill inside ChatClient collapsed by default ('Worked · 3 steps') and never dumps a big thinking block", () => {
    const html = renderToStaticMarkup(
      createElement(ChatClient, {
        conversationId: null,
        isTemporary: false,
        initialMode: "code",
        initialMessages: [
          { role: "user", content: "Build a responsive navbar", created_at: new Date().toISOString() },
          {
            id: "m-steps-1",
            role: "assistant",
            content: "Here is your responsive component.",
            created_at: new Date().toISOString(),
            metadata: {
              mode: "code",
              provider: "GLM",
              model: "glm-4.7",
              tier: "high",
              duration_ms: 1420,
              steps: [
                { id: "route", label: "Routed to GLM", status: "done", detail: "High-load / coding tier", at: 1 },
                { id: "reasoning", label: "Analyzed & structured solution", status: "done", durationMs: 410, at: 2 },
                { id: "generate", label: "Generated response", status: "done", detail: "GLM · glm-4.7", durationMs: 980, at: 3 },
              ],
            },
          },
        ],
      }),
    );

    expect(html).toContain("Worked · 3 steps");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Analyzed &amp; structured solution");
    expect(html).not.toMatch(/Thinking|Thought for/i);
  });

  it("renders live ResponseProgress as a compact single-row pill", () => {
    const liveHtml = renderToStaticMarkup(
      createElement(ResponseProgress, {
        mode: "code",
        provider: "GLM",
        tier: "high",
        steps: [
          { id: "route", label: "Routed to GLM", status: "done", at: 1 },
          { id: "reasoning", label: "Analyzing & structuring solution", status: "running", at: 2 },
        ],
      }),
    );
    expect(liveHtml).toContain("Analyzing &amp; structuring solution");
    expect(liveHtml).toContain('aria-expanded="false"');

    const pillEmpty = renderToStaticMarkup(createElement(CompactStepsPill, { steps: [] }));
    expect(pillEmpty).toBe("");
  });
});

describe("Pillars 4 & 5 — Phone-First OTA Update System, Phone App & Canonical https://matrix.thamjj13.top URL", () => {
  it("compares semantic versions and evaluates optional vs mandatory phone updates accurately", () => {
    expect(compareSemver("1.0.0", "1.1.0")).toBe(-1);
    expect(compareSemver("1.1.0", "1.1.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);

    const outdated = evaluateAppUpdate(SHIPPED_APP_RELEASE, {
      platform: "android",
      currentVersion: "1.0.0",
      currentBuild: 1,
    });
    expect(outdated.update_available).toBe(true);
    expect(outdated.force_update).toBe(false);
    expect(outdated.chat_url).toContain("/chat");

    const current = evaluateAppUpdate(SHIPPED_APP_RELEASE, {
      platform: "android",
      currentVersion: SHIPPED_APP_RELEASE.version,
      currentBuild: SHIPPED_APP_RELEASE.build_number,
    });
    expect(current.update_available).toBe(false);

    const belowMin = evaluateAppUpdate(
      { ...SHIPPED_APP_RELEASE, version: "1.2.0", min_supported_version: "1.1.0" },
      { platform: "android", currentVersion: "1.0.5", currentBuild: 1 },
    );
    expect(belowMin.update_available).toBe(true);
    expect(belowMin.force_update).toBe(true);
  });

  it("serves GET /api/app/version for Android phones and validates admin release publishing", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://matrix.thamjj13.top");
    const req = new NextRequest(
      "https://matrix.thamjj13.top/api/app/version?platform=android&current_version=1.0.0&build=1",
    );
    const res = await getAppVersion(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.update_available).toBe(true);
    expect(json.web_url).toBe("https://matrix.thamjj13.top");
    expect(json.chat_url).toBe("https://matrix.thamjj13.top/chat");

    let stored: Record<string, unknown> = {};
    const mockDb = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: Object.keys(stored).length > 0, data: () => stored }),
          set: async (data: Record<string, unknown>) => {
            stored = { ...stored, ...data };
          },
        }),
      }),
    } as unknown as Db;

    const saved = await saveAppReleaseConfig(mockDb, "admin-uid", {
      version: "1.2.0",
      build_number: 3,
      min_supported_version: "1.1.0",
      force_update: true,
      apk_url: "https://github.com/cht25/matrix-ai/releases/download/mobile-v1.2.0/matrix-android.apk",
      release_notes: "Mandatory security + GLM speed upgrade",
    });
    expect(saved.version).toBe("1.2.0");
    expect(saved.build_number).toBe(3);
    expect(saved.force_update).toBe(true);
  });

  it("aligns canonical https://matrix.thamjj13.top and /chat across SEO, Phone App, Tauri, and deployment configs", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(PRODUCTION_ORIGIN).toBe("https://matrix.thamjj13.top");
    expect(PRODUCTION_CHAT_URL).toBe("https://matrix.thamjj13.top/chat");
    expect(siteOrigin()).toBe("https://matrix.thamjj13.top");
    expect(chatOriginUrl()).toBe("https://matrix.thamjj13.top/chat");

    expect(read("mobile/matrix_app/lib/config.dart")).toContain("https://matrix.thamjj13.top");
    expect(read("mobile/matrix_app/lib/update_service.dart")).toContain("/api/app/version");
    expect(read("mobile/matrix_app/lib/chat_screen.dart")).toContain("Worked ·");
    expect(read("src-tauri/tauri.conf.json")).toContain("https://matrix.thamjj13.top/chat");
    expect(read("apphosting.yaml")).toContain("https://matrix.thamjj13.top");
    expect(read("render.yaml")).toContain("https://matrix.thamjj13.top");
    expect(read("docs/ci/build-android-release.yml")).toContain("matrix-android.apk");
  });
});
