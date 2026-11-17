import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { uid: "upgrade-user-1" } as { uid: string } | null,
}));

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => ({
  getSessionUser: async () => mocks.user,
}));
vi.mock("@/lib/env", () => ({
  isCloudinaryConfigured: () => false,
}));
vi.mock("@/lib/server/cloudinary", () => ({
  uploadPrivateAudio: vi.fn(),
  downloadPrivateAudio: vi.fn(),
  deletePrivateAudio: vi.fn(),
}));
vi.mock("@/lib/ai/cloudflare-quota", () => ({
  assertCloudflareQuota: vi.fn(async () => {}),
  recordCloudflareRequest: vi.fn(async () => {}),
}));

import { listCloudflareModels, testCloudflareModel } from "@/lib/ai/cloudflare";
import { listModelStatus, resetModelHealthForTests, resolvePool } from "@/lib/ai/models/pool";
import { CLOUDFLARE_MODEL_ID, CLOUDFLARE_MODEL_KEY } from "@/lib/ai/models/registry";
import { POST as testModelRoute } from "@/app/api/models/test/route";
import { POST as transcribeRoute } from "@/app/api/voice/transcribe/route";
import { GET as pingGet, HEAD as pingHead } from "@/app/api/ping/route";
import { CompactStepsPill } from "@/components/response-status";
import { VoiceRecordingPanel } from "@/components/voice-composer";
import { OfflineScreen } from "@/components/offline-screen";
import { hasMeaningfulSpeechAudio, isLikelyWhisperHallucination } from "@/lib/voice-input";
import { APP_BUILD_NUMBER, APP_VERSION } from "@/lib/version";
import { SHIPPED_APP_RELEASE } from "@/lib/server/app-updates";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);

beforeEach(() => {
  mocks.user = { uid: "upgrade-user-1" };
  resetModelHealthForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetModelHealthForTests();
});

describe("Phase 2 — Cloudflare GLM 4.7 Flash catalog, diagnostics, /api/models/test, and no silent fallback", () => {
  it("parses Cloudflare UUID id + @cf/... name and paginates to find GLM 4.7 Flash", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.includes("page=2")) {
        return Response.json({
          result: [{ id: "uuid-glm-2", name: CLOUDFLARE_MODEL_ID }],
          result_info: { total_pages: 2 },
        });
      }
      return Response.json({
        result: [{ id: "uuid-llama-1", name: "@cf/meta/llama-3.1-8b-instruct" }],
        result_info: { total_pages: 2 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await listCloudflareModels({
      accountId: "cf-acct-test",
      apiToken: "cf-tok-secret-123",
      model: CLOUDFLARE_MODEL_ID,
    });
    expect(models.map((m) => m.id)).toContain(CLOUDFLARE_MODEL_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache temporary Cloudflare failures and reports distinct diagnostic states", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "cf-acct-test");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-tok-secret-123");
    vi.stubEnv("GROQ_API_KEY", "");

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ errors: [{ message: "rate limit" }] }, { status: 429 }))
        .mockResolvedValueOnce(
          Response.json({
            result: [{ id: "uuid-glm", name: CLOUDFLARE_MODEL_ID }],
            result_info: { total_pages: 1 },
          }),
        ),
    );

    const first = await listModelStatus({ refresh: false });
    const firstGlm = first.find((m) => m.key === CLOUDFLARE_MODEL_KEY)!;
    expect(firstGlm.availability).toBe("unverified");
    expect(firstGlm.status_code).toBe("rate_limited");

    // Second call must NOT be stuck in a 5-min error cache — recovers cleanly.
    const second = await listModelStatus({ refresh: false });
    const secondGlm = second.find((m) => m.key === CLOUDFLARE_MODEL_KEY)!;
    expect(secondGlm.availability).toBe("available");
    expect(secondGlm.status_code).toBe("available");
  });

  it("runs POST /api/models/test safely without leaking tokens and updates status", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "cf-acct-test");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-super-secret-token-xyz");
    vi.stubEnv("GROQ_API_KEY", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes("/ai/run/")) {
          return Response.json({
            result: { choices: [{ message: { content: "OK" } }] },
          });
        }
        return Response.json({
          result: [{ id: "uuid-glm", name: CLOUDFLARE_MODEL_ID }],
          result_info: { total_pages: 1 },
        });
      }),
    );

    const req = new NextRequest("http://localhost/api/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ model_key: CLOUDFLARE_MODEL_KEY }),
    });
    const res = await testModelRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status_code).toBe("available");
    expect(json.latency_ms).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(json)).not.toContain("cf-super-secret-token-xyz");

    // Verify invalid credentials report distinct state cleanly
    const badResult = await testCloudflareModel(
      { accountId: "cf-acct-test", apiToken: "bad-tok", model: CLOUDFLARE_MODEL_ID },
      CLOUDFLARE_MODEL_ID,
    );
    expect(badResult.ok).toBe(true); // mocked fetch still returns OK above

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "Authentication error" }] }), { status: 401 })),
    );
    const fail401 = await testCloudflareModel(
      { accountId: "cf-acct-test", apiToken: "bad-tok", model: CLOUDFLARE_MODEL_ID },
      CLOUDFLARE_MODEL_ID,
    );
    expect(fail401.ok).toBe(false);
    expect(fail401.state).toBe("invalid_credentials");
    expect(fail401.message).not.toContain("bad-tok");
  });

  it("never silently swaps explicit GLM-only manual pool to GPT OSS when GLM is unavailable", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("GROQ_API_KEY", "gsk-configured");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "openai/gpt-oss-120b" }] })));

    const resolved = await resolvePool(null, null, {
      auto: false,
      enabled: [CLOUDFLARE_MODEL_KEY],
    });
    expect(resolved.targets).toHaveLength(0);
    expect(resolved.skipped[0]?.key).toBe(CLOUDFLARE_MODEL_KEY);
  });

  it("shows provider and exact model name in CompactStepsPill", () => {
    const html = renderToStaticMarkup(
      createElement(CompactStepsPill, {
        steps: [{ id: "route", label: "Routed", status: "done", at: 1 }],
        provider: "Cloudflare",
        model: CLOUDFLARE_MODEL_ID,
      }),
    );
    expect(html).toContain("Cloudflare · GLM 4.7 Flash");
  });
});

describe("Phase 3 & 4 — Voice STT VAD, Whisper hallucination guards, Cloudflare Whisper & Dual Mode", () => {
  it("guards against silent mic energy and Whisper silence hallucinations", () => {
    expect(hasMeaningfulSpeechAudio([2, 2, 2, 2, 2, 2], 1800).ok).toBe(false);
    expect(hasMeaningfulSpeechAudio([2, 18, 34, 22, 12, 3], 1800).ok).toBe(true);
    expect(hasMeaningfulSpeechAudio([2], 1200).ok).toBe(true); // analyser unavailable fallback

    expect(isLikelyWhisperHallucination("...")).toBe(true);
    expect(isLikelyWhisperHallucination("Thanks for watching")).toBe(true);
    expect(isLikelyWhisperHallucination("Thank you", [{ no_speech_prob: 0.96 }])).toBe(true);
    expect(isLikelyWhisperHallucination("Hello world.", [{ no_speech_prob: 0.12 }])).toBe(false);
    expect(isLikelyWhisperHallucination("আমি ভালো আছি")).toBe(false);
  });

  it("transcribes with Cloudflare Whisper when configured standalone and rejects no-speech hallucinations", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "cf-acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-tok");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          result: {
            text: "Build a dashboard with dark mode",
            transcription_info: { language: "en" },
          },
        }),
      ),
    );

    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(webm)], { type: "audio/webm" }), "voice.webm");
    form.append("store", "0");
    form.append("duration_ms", "1600");

    const res = await transcribeRoute(
      new NextRequest("http://localhost/api/voice/transcribe", {
        method: "POST",
        headers: { Authorization: "Bearer test" },
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.transcript).toBe("Build a dashboard with dark mode");
    expect(json.provider).toBe("Cloudflare");
    expect(json.stored).toBe(false);

    // Hallucinated silence from Whisper returns 422 NO_SPEECH_DETECTED
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          result: {
            text: "Thank you.",
            segments: [{ no_speech_prob: 0.94 }],
          },
        }),
      ),
    );
    const silentForm = new FormData();
    silentForm.append("audio", new Blob([new Uint8Array(webm)], { type: "audio/webm" }), "voice.webm");
    silentForm.append("store", "0");
    const silentRes = await transcribeRoute(
      new NextRequest("http://localhost/api/voice/transcribe", {
        method: "POST",
        headers: { Authorization: "Bearer test" },
        body: silentForm,
      }),
    );
    expect(silentRes.status).toBe(422);
    expect((await silentRes.json()).error).toBe("NO_SPEECH_DETECTED");
  });

  it("renders Mode A (Done -> transcribe) by default and Mode B (Hands-free -> Send) when enabled", () => {
    const modeAHtml = renderToStaticMarkup(
      createElement(VoiceRecordingPanel, {
        paused: false,
        requesting: false,
        elapsedMs: 3200,
        canvasRef: { current: null },
        hasWaveform: true,
        voiceMode: "dictate",
        language: "auto",
        onLanguage: () => {},
        onCancel: () => {},
        onPause: () => {},
        onStop: () => {},
      }),
    );
    expect(modeAHtml).toContain("Done");
    expect(modeAHtml).toContain("Stop recording and transcribe to composer");
    expect(modeAHtml).not.toContain("Hands-free");

    const modeBHtml = renderToStaticMarkup(
      createElement(VoiceRecordingPanel, {
        paused: false,
        requesting: false,
        elapsedMs: 3200,
        canvasRef: { current: null },
        hasWaveform: true,
        voiceMode: "hands_free",
        language: "auto",
        onLanguage: () => {},
        onCancel: () => {},
        onPause: () => {},
        onStop: () => {},
      }),
    );
    expect(modeBHtml).toContain("Send");
    expect(modeBHtml).toContain("Hands-free");
  });
});

describe("Phase 5, 6, 7 & 9 — Offline mode, SW, /api/ping, version sync, and app_build_guide.md", () => {
  it("serves /api/ping with no-store cache headers and synchronized version", async () => {
    const res = await pingGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(APP_VERSION);
    expect(body.build).toBe(APP_BUILD_NUMBER);

    const head = await pingHead();
    expect(head.status).toBe(200);
  });

  it("ships real service worker + offline fallback page", () => {
    expect(existsSync(join(__dirname, "..", "public/sw.js"))).toBe(true);
    const sw = read("public/sw.js");
    expect(sw).toContain("/offline");
    expect(sw).toContain("/api/");
    expect(sw).toContain("SKIP_WAITING");

    const offlineHtml = renderToStaticMarkup(createElement(OfflineScreen));
    expect(offlineHtml).toContain("Retry connection");
    expect(offlineHtml).toContain("Cached conversations on this device");
  });

  it("synchronizes app versions across web, Tauri desktop, Android mobile, and build guide", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json")) as { version: string };
    const cargo = read("src-tauri/Cargo.toml");
    const pubspec = read("mobile/matrix_app/pubspec.yaml");
    const dartCfg = read("mobile/matrix_app/lib/config.dart");

    expect(pkg.version).toBe(APP_VERSION);
    expect(SHIPPED_APP_RELEASE.version).toBe(APP_VERSION);
    expect(SHIPPED_APP_RELEASE.build_number).toBe(APP_BUILD_NUMBER);
    expect(tauriConf.version).toBe(APP_VERSION);
    expect(cargo).toContain(`version = "${APP_VERSION}"`);
    expect(pubspec).toContain(`version: ${APP_VERSION}+${APP_BUILD_NUMBER}`);
    expect(dartCfg).toContain(`defaultValue: '${APP_VERSION}'`);

    expect(existsSync(join(__dirname, "..", "app_build_guide.md"))).toBe(true);
    const guide = read("app_build_guide.md");
    expect(guide).toContain("npx tauri build");
    expect(guide).toContain("flutter build apk");
    expect(guide).toContain("public/sw.js");
  });
});
